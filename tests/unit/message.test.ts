import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { formatMessage, buildUsernameMap } from '../../utils/message.js';
import type { LeanMessage } from '../../types/lean.js';

function makeLeanMessage(overrides: Partial<LeanMessage> = {}): LeanMessage {
    return {
        _id: new mongoose.Types.ObjectId(),
        roomId: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        text: 'hello',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        parentMessageId: null,
        replyCount: 0,
        ...overrides,
    };
}

test('formatMessage maps all fields correctly', () => {
    const userId = new mongoose.Types.ObjectId();
    const msg = makeLeanMessage({ userId, text: 'hi', replyCount: 3 });
    const map = new Map([[userId.toString(), 'alice']]);

    const result = formatMessage(msg, map);

    assert.equal(result.id, msg._id.toString());
    assert.equal(result.roomId, msg.roomId.toString());
    assert.equal(result.userId, userId.toString());
    assert.equal(result.username, 'alice');
    assert.equal(result.text, 'hi');
    assert.equal(result.createdAt, msg.createdAt.getTime());
    assert.equal(result.parentMessageId, null);
    assert.equal(result.replyCount, 3);
});

test('formatMessage returns empty username for unknown user', () => {
    const msg = makeLeanMessage();
    const result = formatMessage(msg, new Map());
    assert.equal(result.username, '');
});

test('formatMessage includes parentMessageId when present', () => {
    const parentId = new mongoose.Types.ObjectId();
    const msg = makeLeanMessage({ parentMessageId: parentId });
    const result = formatMessage(msg, new Map());
    assert.equal(result.parentMessageId, parentId.toString());
});

test('buildUsernameMap creates correct map', () => {
    const id1 = new mongoose.Types.ObjectId();
    const id2 = new mongoose.Types.ObjectId();

    const users = [
        { _id: id1, username: 'alice' },
        { _id: id2, username: 'bob' },
    ];

    const map = buildUsernameMap(users);
    assert.equal(map.get(id1.toString()), 'alice');
    assert.equal(map.get(id2.toString()), 'bob');
});

test('buildUsernameMap returns empty string for users without username', () => {
    const id = new mongoose.Types.ObjectId();
    const map = buildUsernameMap([{ _id: id }]);
    assert.equal(map.get(id.toString()), '');
});
