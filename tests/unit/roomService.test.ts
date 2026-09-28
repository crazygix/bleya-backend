import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
    toRoomSummary,
    isPublicRoom,
} from '../../services/roomService.js';

test('toRoomSummary maps lean room to DTO', () => {
    const room = {
        _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'),
        name: 'Test Room',
        type: 'public' as const,
        cityKey: 'paris-fr',
        imageUrl: 'https://example.com/img.jpg',
        geo: { type: 'Point' as const, coordinates: [2.35, 48.85] },
    };

    const dto = toRoomSummary(room);
    assert.equal(dto.id, '507f1f77bcf86cd799439011');
    assert.equal(dto.name, 'Test Room');
    assert.equal(dto.type, 'public');
    assert.equal(dto.cityKey, 'paris-fr');
    assert.equal(dto.imageUrl, 'https://example.com/img.jpg');
    assert.deepEqual(dto.location, { latitude: 48.85, longitude: 2.35 });
});

test('toRoomSummary handles missing optional fields', () => {
    const room = {
        _id: new mongoose.Types.ObjectId(),
        name: 'Minimal',
    };

    const dto = toRoomSummary(room);
    assert.equal(dto.name, 'Minimal');
    assert.equal(dto.type, 'public');
    assert.equal(dto.cityKey, null);
    assert.equal(dto.imageUrl, null);
    assert.equal(dto.location, null);
});

test('isPublicRoom returns true for public rooms', () => {
    assert.ok(isPublicRoom({ type: 'public' }));
    assert.ok(isPublicRoom({})); // defaults to public
});

test('isPublicRoom returns false for private rooms', () => {
    assert.equal(isPublicRoom({ type: 'private' }), false);
});
