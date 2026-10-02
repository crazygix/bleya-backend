import test from 'node:test';
import assert from 'node:assert/strict';
import { findPasskeyOriginProblems } from '../../config/index.js';

const RP_ID = 'bleyachat.com';
const WEBSITE = 'https://bleyachat.com';
// The upload key: its SHA-256 as Play Console shows it, and the passkey origin
// Android reports for apps signed with it.
const UPLOAD_KEY_SHA256 = '7E:B2:01:C0:48:9E:95:46:78:D1:B6:FE:38:BB:17:4C:40:DF:F1:56:47:7A:5B:37:90:21:FD:FE:88:D2:52:D3';
const UPLOAD_KEY_HASH = 'frIBwEielUZ40bb-OLsXTEDf8VZHels3kCH9_ojSUtM';
const UPLOAD_KEY_ORIGIN = `android:apk-key-hash:${UPLOAD_KEY_HASH}`;

const NO_ANDROID_ORIGIN = 'No android:apk-key-hash: origin is listed, so passkeys fail in the Android app.';

test('a website origin plus Android origins has no problems', () => {
    // The origin is the certificate's SHA-256 in base64url without padding.
    assert.equal(Buffer.from(UPLOAD_KEY_SHA256.replaceAll(':', ''), 'hex').toString('base64url'), UPLOAD_KEY_HASH);

    assert.deepEqual(findPasskeyOriginProblems([WEBSITE, UPLOAD_KEY_ORIGIN], RP_ID), []);
    // Origins that are neither are allowed alongside.
    assert.deepEqual(findPasskeyOriginProblems([WEBSITE, UPLOAD_KEY_ORIGIN, 'https://www.bleyachat.com'], RP_ID), []);
});

test('an empty list stands for the website only, so Android is flagged', () => {
    assert.deepEqual(findPasskeyOriginProblems([], RP_ID), [NO_ANDROID_ORIGIN]);
    assert.deepEqual(findPasskeyOriginProblems([WEBSITE], RP_ID), [NO_ANDROID_ORIGIN]);
});

test('a list without the exact website origin is flagged', () => {
    const missingWebsite = 'https://bleyachat.com is missing, so passkeys fail on iOS.';

    assert.deepEqual(findPasskeyOriginProblems([UPLOAD_KEY_ORIGIN], RP_ID), [missingWebsite]);
    // Origins are matched exactly.
    assert.deepEqual(findPasskeyOriginProblems(['https://bleyachat.com/', UPLOAD_KEY_ORIGIN], RP_ID), [missingWebsite]);
    assert.deepEqual(
        findPasskeyOriginProblems([WEBSITE, UPLOAD_KEY_ORIGIN], 'example.com'),
        ['https://example.com is missing, so passkeys fail on iOS.']
    );
});

test('malformed Android origins are flagged by name', () => {
    const cases: Array<[origin: string, reason: RegExp]> = [
        [`${UPLOAD_KEY_ORIGIN}=`, /without padding/],
        [`android:apk-key-hash:${UPLOAD_KEY_HASH.replace('-', '+').replace('_', '/')}`, /'-' and '_' instead of '\+' and '\/'/],
        [`android:apk-key-hash:${UPLOAD_KEY_SHA256}`, /hex fingerprint/],
        [`android:apk-key-hash:${UPLOAD_KEY_SHA256.replaceAll(':', '').toLowerCase()}`, /hex fingerprint/],
        [UPLOAD_KEY_ORIGIN.slice(0, -1), /43 characters/],
        [UPLOAD_KEY_ORIGIN.replace('apk-key-hash', 'apk-key-hash-sha256'), /must start with android:apk-key-hash:/],
    ];

    for (const [origin, reason] of cases) {
        const problems = findPasskeyOriginProblems([WEBSITE, origin], RP_ID);
        // A malformed Android origin is still an Android origin, so only it is reported.
        assert.equal(problems.length, 1, `${origin}: ${JSON.stringify(problems)}`);
        assert.ok(problems[0].startsWith(`${origin} `), problems[0]);
        assert.match(problems[0], reason);
    }

    // A well-formed origin next to a malformed one doesn't hide it.
    assert.equal(findPasskeyOriginProblems([WEBSITE, UPLOAD_KEY_ORIGIN, `${UPLOAD_KEY_ORIGIN}=`], RP_ID).length, 1);
});
