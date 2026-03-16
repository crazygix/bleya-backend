import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    type AuthenticationResponseJSON,
    type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { config } from '../config/index.js';
import { ValidationError } from '../utils/errors.js';

export interface PasskeyRegistrationResult {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    deviceType: string;
    backedUp: boolean;
    aaguid: string;
}

export interface PasskeyAuthenticationResult {
    credentialId: string;
    newCounter: number;
}

export interface AuthenticatorDescriptor {
    credentialId: string;
    transports?: string[];
}

export interface StoredAuthenticator {
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
}

export interface PasskeyService {
    generateRegistrationOptions(params: {
        userId: string;
        username: string;
        displayName: string;
        existingCredentials: AuthenticatorDescriptor[];
    }): Promise<PublicKeyCredentialCreationOptionsJSON>;
    verifyRegistration(params: {
        expectedChallenge: string;
        response: RegistrationResponseJSON;
    }): Promise<PasskeyRegistrationResult>;
    generateAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
    verifyAuthentication(params: {
        expectedChallenge: string;
        response: AuthenticationResponseJSON;
        authenticator: StoredAuthenticator;
    }): Promise<PasskeyAuthenticationResult>;
}

function toExpectedOrigins(): string[] {
    return config.passkey.expectedOrigins.length > 0
        ? config.passkey.expectedOrigins
        : [`https://${config.passkey.rpId}`];
}

export class SimpleWebAuthnPasskeyService implements PasskeyService {
    async generateRegistrationOptions(params: {
        userId: string;
        username: string;
        displayName: string;
        existingCredentials: AuthenticatorDescriptor[];
    }) {
        return generateRegistrationOptions({
            rpID: config.passkey.rpId,
            rpName: config.passkey.rpName,
            userID: Buffer.from(params.userId, 'utf8'),
            userName: params.username,
            userDisplayName: params.displayName,
            attestationType: 'none',
            timeout: 60_000,
            authenticatorSelection: {
                residentKey: 'preferred',
                userVerification: 'preferred',
                authenticatorAttachment: 'platform',
            },
            excludeCredentials: params.existingCredentials.map((credential) => ({
                id: credential.credentialId,
                transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
            })),
        });
    }

    async verifyRegistration(params: {
        expectedChallenge: string;
        response: RegistrationResponseJSON;
    }) {
        const verification = await verifyRegistrationResponse({
            response: params.response,
            expectedChallenge: params.expectedChallenge,
            expectedOrigin: toExpectedOrigins(),
            expectedRPID: config.passkey.rpId,
            requireUserVerification: true,
        });

        if (!verification.verified || !verification.registrationInfo) {
            throw new ValidationError('That passkey could not be confirmed. Try again.');
        }

        return {
            credentialId: verification.registrationInfo.credential.id,
            publicKey: Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64url'),
            counter: verification.registrationInfo.credential.counter,
            transports: (verification.registrationInfo.credential.transports || []) as string[],
            deviceType: verification.registrationInfo.credentialDeviceType,
            backedUp: verification.registrationInfo.credentialBackedUp,
            aaguid: verification.registrationInfo.aaguid,
        };
    }

    async generateAuthenticationOptions() {
        return generateAuthenticationOptions({
            rpID: config.passkey.rpId,
            timeout: 60_000,
            userVerification: 'preferred',
        });
    }

    async verifyAuthentication(params: {
        expectedChallenge: string;
        response: AuthenticationResponseJSON;
        authenticator: StoredAuthenticator;
    }) {
        const verification = await verifyAuthenticationResponse({
            response: params.response,
            expectedChallenge: params.expectedChallenge,
            expectedOrigin: toExpectedOrigins(),
            expectedRPID: config.passkey.rpId,
            requireUserVerification: true,
            credential: {
                id: params.authenticator.credentialId,
                publicKey: Buffer.from(params.authenticator.publicKey, 'base64url'),
                counter: params.authenticator.counter,
                transports: params.authenticator.transports as AuthenticatorTransportFuture[] | undefined,
            },
        });

        if (!verification.verified || !verification.authenticationInfo) {
            throw new ValidationError('That passkey sign-in could not be confirmed. Try again.');
        }

        return {
            credentialId: verification.authenticationInfo.credentialID,
            newCounter: verification.authenticationInfo.newCounter,
        };
    }
}

export const passkeyService: PasskeyService = new SimpleWebAuthnPasskeyService();
