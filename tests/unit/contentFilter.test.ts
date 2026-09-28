import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config/index.js';
import { containsBlockedTerm, resetContentFilterCacheForTests } from '../../utils/contentFilter.js';

// Everyday text that the old space-stripping matcher rejected, plus words that
// merely contain a blocked term.
const HARMLESS = [
    'who really cares',
    'finish it tonight',
    'this hit song is great',
    'a bit chilly today',
    'Scunthorpe United',
    'an assessment of the class',
    "it's a cocktail party",
    'meet the therapist at 5',
    'hello @everyone!!',
    'the year 2025',
    'Šta ima? Idemo na piće',
];

const EVASIVE = [
    'fuck',
    'FUCK OFF',
    'f u c k',
    'f.u.c.k this',
    "fu'ck you",
    'sh!t happens',
    '$hit',
    'sh1t',
    'fück',
    'ｆｕｃｋ',
    'total bullshit',
    'clusterfucking mess',
    'fu​ck',
    'fuсk',
    'what a bitch',
    'bitches',
    'you asshole',
];

test('content filter allows everyday text', () => {
    for (const phrase of HARMLESS) {
        assert.equal(containsBlockedTerm(phrase), false, phrase);
    }
});

test('content filter catches common evasions', () => {
    for (const phrase of EVASIVE) {
        assert.equal(containsBlockedTerm(phrase), true, phrase);
    }
});

test('custom terms match whole words, with optional wildcards and phrases', () => {
    const original = config.contentFilter.blockedTerms;
    config.contentFilter.blockedTerms = ['badword', 'slur*', 'kill yourself'];
    resetContentFilterCacheForTests();

    try {
        assert.equal(containsBlockedTerm('that is a badword'), true);
        assert.equal(containsBlockedTerm('badwords'), false);
        assert.equal(containsBlockedTerm('slurring'), true);
        assert.equal(containsBlockedTerm('just kill yourself'), true);
        assert.equal(containsBlockedTerm('kill the lights yourself'), false);
    } finally {
        config.contentFilter.blockedTerms = original;
        resetContentFilterCacheForTests();
    }
});
