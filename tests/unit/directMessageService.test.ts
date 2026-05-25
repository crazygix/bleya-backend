import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectParticipantsHash } from '../../services/directMessageService.js';

describe('buildDirectParticipantsHash', () => {
    it('produces the same hash regardless of argument order', () => {
        const a = '0123456789abcdef01234567';
        const b = 'fedcba9876543210fedcba98';
        assert.equal(
            buildDirectParticipantsHash(a, b),
            buildDirectParticipantsHash(b, a)
        );
    });

    it('joins the sorted ids with an underscore', () => {
        const a = 'aaaaaaaaaaaaaaaaaaaaaaaa';
        const b = 'bbbbbbbbbbbbbbbbbbbbbbbb';
        assert.equal(buildDirectParticipantsHash(b, a), `${a}_${b}`);
    });
});
