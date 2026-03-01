import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { toRoomLocation, isPrivateRoomParticipant } from '../../utils/room.js';

test('toRoomLocation extracts lat/lng from geo', () => {
    const result = toRoomLocation({ geo: { type: 'Point', coordinates: [2.35, 48.85] } });
    assert.deepEqual(result, { latitude: 48.85, longitude: 2.35 });
});

test('toRoomLocation returns null when geo is missing', () => {
    assert.equal(toRoomLocation({}), null);
    assert.equal(toRoomLocation({ geo: {} }), null);
    assert.equal(toRoomLocation({ geo: { coordinates: [] } }), null);
});

test('toRoomLocation returns null for invalid coordinates', () => {
    assert.equal(toRoomLocation({ geo: { coordinates: [NaN, 0] } }), null);
    assert.equal(toRoomLocation({ geo: { coordinates: [Infinity, 0] } }), null);
});

test('toRoomLocation returns null for single coordinate', () => {
    assert.equal(toRoomLocation({ geo: { coordinates: [1] } }), null);
});

test('isPrivateRoomParticipant returns true for public rooms', () => {
    const userId = new mongoose.Types.ObjectId().toString();
    assert.ok(isPrivateRoomParticipant({ type: 'public' }, userId));
});

test('isPrivateRoomParticipant returns true when user is a participant', () => {
    const userId = new mongoose.Types.ObjectId();
    assert.ok(isPrivateRoomParticipant(
        { type: 'private', participants: [userId, new mongoose.Types.ObjectId()] },
        userId.toString()
    ));
});

test('isPrivateRoomParticipant returns false when user is not a participant', () => {
    const userId = new mongoose.Types.ObjectId().toString();
    assert.equal(isPrivateRoomParticipant(
        { type: 'private', participants: [new mongoose.Types.ObjectId()] },
        userId
    ), false);
});

test('isPrivateRoomParticipant returns true when type is missing (defaults to public)', () => {
    assert.ok(isPrivateRoomParticipant({}, 'anything'));
});
