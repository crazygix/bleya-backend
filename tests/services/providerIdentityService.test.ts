import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { providerIdentityService } from '../../services/providerIdentityService.js';

function makeProviderTestToken(claims: Record<string, unknown>): string {
    return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
}

describe('providerIdentityService', () => {
    it('accepts Apple test tokens when the hashed nonce matches', async () => {
        const rawNonce = 'apple-test-nonce';
        const hashedNonce = crypto.createHash('sha256').update(rawNonce).digest('base64url');

        const result = await providerIdentityService.verifyAppleIdToken(
            makeProviderTestToken({
                sub: 'apple-user-1',
                email: 'Alice@Example.com',
                email_verified: true,
                is_private_email: false,
                nonce: hashedNonce,
            }),
            rawNonce,
        );

        assert.equal(result.provider, 'apple');
        assert.equal(result.providerUserId, 'apple-user-1');
        assert.equal(result.email, 'alice@example.com');
        assert.equal(result.emailVerified, true);
        assert.equal(result.isPrivateRelay, false);
    });

    it('rejects Apple test tokens when the nonce does not match', async () => {
        const token = makeProviderTestToken({
            sub: 'apple-user-1',
            nonce: crypto.createHash('sha256').update('expected-nonce').digest('base64url'),
        });

        await assert.rejects(
            () => providerIdentityService.verifyAppleIdToken(token, 'wrong-nonce'),
            /Unable to verify that Apple sign-in attempt\./,
        );
    });
});
