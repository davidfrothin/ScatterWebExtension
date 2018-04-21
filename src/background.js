import {LocalStream} from 'extension-streams';
import AES from 'aes-oop';
import * as InternalMessageTypes from './messages/InternalMessageTypes';
import InternalMessage from './messages/InternalMessage';
import StorageService from './services/StorageService'
import SignatureService from './services/SignatureService'
import Scatter from './models/Scatter'
import Network from './models/Network'
import Identity from './models/Identity'
import IdentityService from './services/IdentityService'
import NotificationService from './services/NotificationService'
import HistoricEvent from './models/histories/HistoricEvent'
import * as HistoricEventTypes from './models/histories/HistoricEventTypes'
import Prompt from './models/prompts/Prompt';
import * as PromptTypes from './models/prompts/PromptTypes'
import ObjectHelpers from './util/ObjectHelpers'
import Permission from './models/Permission'
import TimingHelpers from './util/TimingHelpers';
import Error from './models/errors/Error'
import ContractHelpers from './util/ContractHelpers'
const ecc = require('eosjs-ecc');
import {apis} from './util/BrowserApis';

// Gets bound when a user logs into scatter
// and unbound when they log out
// Is not on the Background's scope to keep it private
let seed = '';

let inactivityInterval = 0;
let timeoutLocker = null;

// This is the script that runs in the extension's background ( singleton )
export default class Background {

    constructor(){
        this.setupInternalMessaging();
    }



    /********************************************/
    /*               VueInitializer             */
    /********************************************/

    // Watches the internal messaging system ( LocalStream )
    setupInternalMessaging(){
        LocalStream.watch((request, sendResponse) => {
            const message = InternalMessage.fromJson(request);
            this.dispenseMessage(sendResponse, message);
        })
    }

    /***
     * Delegates message processing to methods by message type
     * @param sendResponse - Delegating response handler
     * @param message - The message to be dispensed
     */
    dispenseMessage(sendResponse, message){
        Background.checkAutoLock();
        switch(message.type){
            case InternalMessageTypes.SET_SEED:                     Background.setSeed(sendResponse, message.payload); break;
            case InternalMessageTypes.SET_TIMEOUT:                  Background.setTimeout(sendResponse, message.payload); break;
            case InternalMessageTypes.IS_UNLOCKED:                  Background.isUnlocked(sendResponse); break;
            case InternalMessageTypes.LOAD:                         Background.load(sendResponse); break;
            case InternalMessageTypes.UPDATE:                       Background.update(sendResponse, message.payload); break;
            case InternalMessageTypes.PUB_TO_PRIV:                  Background.publicToPrivate(sendResponse, message.payload); break;
            case InternalMessageTypes.DESTROY:                      Background.destroy(sendResponse); break;
            case InternalMessageTypes.IDENTITY_FROM_PERMISSIONS:    Background.identityFromPermissions(sendResponse, message.payload); break;
            case InternalMessageTypes.GET_OR_REQUEST_IDENTITY:      Background.getOrRequestIdentity(sendResponse, message.payload); break;
            case InternalMessageTypes.REQUEST_SIGNATURE:            Background.requestSignature(sendResponse, message.payload); break;
            case InternalMessageTypes.REQUEST_ADD_NETWORK:          Background.requestAddNetwork(sendResponse, message.payload); break;
            case InternalMessageTypes.REQUEST_GET_VERSION:          Background.requestGetVersion(sendResponse); break;
            case InternalMessageTypes.REQUEST_VERSION_UPDATE:       Background.requestVersionUpdate(sendResponse, message.payload); break;
            case InternalMessageTypes.AUTHENTICATE:                 Background.authenticate(sendResponse, message.payload); break;
        }
    }

    // Lock the user due to inactivity
    static checkAutoLock() {
        if(inactivityInterval === 0) return false;
        if (timeoutLocker) clearTimeout(timeoutLocker);
        if (seed) timeoutLocker = setTimeout(() => seed = '', inactivityInterval);
    }



    /********************************************/
    /*                 Handlers                 */
    /********************************************/

    /***
     * Sets the seed on scope to use from decryption
     * @param sendResponse - Delegating response handler
     * @param _seed - The seed to set
     */
    static setSeed(sendResponse, _seed){
        seed = _seed;
        sendResponse(true);
    }

    /***
     * Checks whether Scatter is locked
     * @param sendResponse - Delegating response handler
     * @returns {boolean}
     */
    static isUnlocked(sendResponse){
        // Even if a seed is set, that doesn't mean that the seed is correct.
        if(seed.length) StorageService.get().then(scatter => {
            try {
                scatter.decrypt(seed);
                sendResponse(typeof scatter.keychain === 'object');
            } catch(e) {
                seed = '';
                sendResponse(false);
            }
        });
        // If no seed is set, Scatter is definitely locked
        else sendResponse(false);
    }

    /***
     * Returns the saved instance of Scatter from the storage
     * @param sendResponse - Delegating response handler
     * @returns {Scatter}
     */
    static load(sendResponse){
        StorageService.get().then(scatter => {

            // sync the timeout inactivity interval
            inactivityInterval = scatter.settings.inactivityInterval;

            if(seed.length) scatter.decrypt(seed);
            sendResponse(scatter)
        })
    }

    /***
     * Updates the Scatter instance inside persistent storage
     * @param sendResponse - Delegating response handler
     * @param scatter - The updated cleartext Scatter instance
     * @returns {boolean}
     */
    static update(sendResponse, scatter){
        this.lockGuard(sendResponse, () => {
            scatter = Scatter.fromJson(scatter);

            // Private Keys are always separately encrypted
            scatter.keychain.keypairs.map(keypair => keypair.encrypt(seed));
            scatter.keychain.identities.map(id => id.encrypt(seed));

            // Keychain is always stored encrypted.
            scatter.encrypt(seed);

            StorageService.save(scatter).then(saved => {
                scatter.decrypt(seed);
                sendResponse(scatter)
            })
        })
    }

    /***
     * Retrieves a Private Key from a Public Key
     * @param sendResponse - Delegating response handler
     * @param publicKey - The Public Key to search for
     * @returns {privateKey:string | null}
     */
    static publicToPrivate(sendResponse, publicKey){
        this.lockGuard(sendResponse, () => {
            StorageService.get().then(scatter => {
                scatter.decrypt(seed);
                const keypair = scatter.keychain.keypairs.find(x => x.publicKey === publicKey);
                sendResponse((keypair) ? AES.decrypt(keypair.privateKey, seed) : null);
            })
        })
    }

    /***
     * Destroys this instance of Scatter
     * @param sendResponse
     */
    static destroy(sendResponse){
        // TODO: Mock
        this.lockGuard(sendResponse, () => {
            console.log("Destroying");
            seed = '';
            apis.storage.local.clear();
            sendResponse(true);
        })
    }

    /***
     * Sets the timeout interval on scope to determine the lockout time
     * @param sendResponse - Delegating response handler
     * @param _timeoutMinutes - The timeout minutes to set
     */
    static setTimeout(sendResponse, _timeoutMinutes){
        this.load(scatter => {
            inactivityInterval = TimingHelpers.minutes(_timeoutMinutes);
            scatter.settings.inactivityInterval = inactivityInterval;
            this.update(() => {}, scatter);
        });

        sendResponse(true);
    }













    /********************************************/
    /*              Web Application             */
    /********************************************/

    static identityFromPermissions(sendResponse, payload){
        if(!seed.length) {
            sendResponse(null);
            return false;
        }

        Background.load(scatter => {
            const domain = payload.domain;
            const permission = IdentityService.identityPermission(domain, scatter);
            if(!permission){
                sendResponse(null);
                return false;
            }
            const identity = permission.identity(scatter.keychain);
            sendResponse(identity.asOnlyRequiredFields(permission.fields, permission.network));
        });
    }

    /***
     * Prompts a request for Identity provision
     * @param sendResponse
     * @param payload
     */
    static getOrRequestIdentity(sendResponse, payload){
        this.lockGuard(sendResponse, () => {
            Background.load(scatter => {
                const {domain, fields} = payload;
                const network = Network.fromJson(payload.network);

                IdentityService.getOrRequestIdentity(domain, network, fields, scatter, (identity, fromPermission) => {
                    if(!identity){
                        sendResponse(Error.signatureError("identity_rejected", "User rejected the provision of an Identity"));
                        return false;
                    }

                    if(!fromPermission) {
                        this.addHistory(HistoricEventTypes.PROVIDED_IDENTITY, {
                            domain,
                            network,
                            provided:!!identity,
                            identityName:identity ? identity.name : false,
                            publicKey:(identity) ? identity.publicKey : false
                        });

                        this.addPermissions([Permission.fromJson({
                            domain,
                            network,
                            publicKey:identity.publicKey,
                            timestamp:+ new Date(),
                            fields
                        })])
                    }

                    sendResponse(identity);
                });
            });
        })
    }

    /***
     * Authenticates the Identity by returning a signed passphrase using the
     * private key associated with the Identity
     * @param sendResponse
     * @param payload
     */
    static authenticate(sendResponse, payload){
        this.lockGuard(sendResponse, () => {
            Background.load(scatter => {
                const identity = scatter.keychain.findIdentity(payload.publicKey);
                if(!identity){
                    sendResponse(Error.identityMissing());
                    return;
                }

                identity.decrypt(seed);
                if(!ecc.isValidPrivate(identity.privateKey)){
                    sendResponse(Error.maliciousEvent());
                    return;
                }

                sendResponse(ecc.sign(payload.domain, identity.privateKey));
            })
        })
    }

    /***
     * Prompts a request for a transaction signature
     * @param sendResponse
     * @param payload
     */
    static requestSignature(sendResponse, payload){
        this.lockGuard(sendResponse, () => {
            Background.load(scatter => {
                SignatureService.requestSignature(payload, scatter, this, sendResponse);
            })
        })
    }

    /***
     *
     * @param sendResponse
     * @param payload
     */
    static requestAddNetwork(sendResponse, payload){
        this.lockGuard(sendResponse, () => {
            Background.load(scatter => {

                const network = Network.fromJson(payload.network);

                // Already has network, returning true
                if(scatter.settings.networks.find(_network => _network.unique() === network.unique())) sendResponse(true);

                // Prompting for network addition
                else NotificationService.open(new Prompt(PromptTypes.REQUEST_ADD_NETWORK, payload.domain, payload.network, network, approved => {
                    if(approved === false || approved.hasOwnProperty('isError')) sendResponse(approved);
                    else {
                        scatter.settings.networks.unshift(network);
                        this.update(() => sendResponse(approved), scatter);
                    }
                }));

            })
        })
    }

    /***
     * Gets the current version of the app from the manifest.json
     * @param sendResponse
     */
    static requestGetVersion(sendResponse){
        sendResponse(apis.app.getDetails().version)
    }

    /***
     * Notifies the user that the application they are using is
     * requiring a newer version of Scatter than they have installed
     * @param sendResponse
     * @param payload
     */
    static requestVersionUpdate(sendResponse, payload){
        const network = Network.fromJson({host:'', port:0});
        NotificationService.open(new Prompt(PromptTypes.UPDATE_VERSION, payload.domain, network, network, () => {}))
    }





    /********************************************/
    /*                 Helpers                  */
    /********************************************/

    /***
     * Returns a an error if Scatter is locked,
     * or passes through the callback if Scatter is open
     * @param sendResponse - Delegating response handler
     * @param cb - Callback to perform if open
     */
    static lockGuard(sendResponse, cb){
        if(!seed.length) {
            NotificationService.open(Prompt.scatterIsLocked());
            sendResponse(Error.locked());
        }
        else cb();
    }



    /***
     * Adds a historic event to the keychain
     * @param type
     * @param data
     */
    static addHistory(type, data){
        this.load(scatter => {
            scatter.histories.unshift(new HistoricEvent(type, data));
            this.update(() => {}, scatter);
        })
    }

    /***
     * Adds a permission to the keychain
     * @param permissions
     */
    static addPermissions(permissions){
        this.load(scatter => {
            permissions.map(permission => {
                if(!scatter.keychain.hasPermission(permission.checksum, permission.fields))
                    scatter.keychain.permissions.unshift(permission);
            });
            this.update(() => {}, scatter);
        })
    }

}

const background = new Background();
