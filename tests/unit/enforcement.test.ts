import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEnforcementForUser } from '../../utils/enforcement.js';

test('describeEnforcementForUser is null for active and lapsed accounts', () => {
    assert.equal(describeEnforcementForUser({ status: 'active' }), null);
    assert.equal(describeEnforcementForUser({
        status: 'suspended',
        suspendedUntil: new Date(Date.now() - 60_000),
    }), null);
});

test('describeEnforcementForUser explains bans and suspensions', () => {
    assert.equal(
        describeEnforcementForUser({ status: 'banned', enforcementReason: 'spam' }),
        'Your account has been banned. Reason: spam'
    );
    assert.equal(describeEnforcementForUser({ status: 'banned' }), 'Your account has been banned.');
    assert.equal(
        describeEnforcementForUser({ status: 'suspended', suspendedUntil: new Date('2999-01-02T00:00:00Z') }),
        'Your account is suspended until 2999-01-02.'
    );
    assert.equal(describeEnforcementForUser({ status: 'suspended' }), 'Your account is suspended.');
});
