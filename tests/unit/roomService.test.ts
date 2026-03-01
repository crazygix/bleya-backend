import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
    toRoomSummary,
    buildPublicRoomFilter,
    escapeRegex,
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

test('buildPublicRoomFilter returns type filter without search', () => {
    const filter = buildPublicRoomFilter();
    assert.deepEqual(filter, { type: 'public' });
});

test('buildPublicRoomFilter adds case-insensitive regex for search', () => {
    const filter = buildPublicRoomFilter('Berlin') as { type: string; name: { $regex: RegExp } };
    assert.equal(filter.type, 'public');
    assert.ok(filter.name.$regex instanceof RegExp);
    assert.ok(filter.name.$regex.test('Berlin'));
    assert.ok(filter.name.$regex.test('berlin'));
});

test('escapeRegex escapes special regex characters', () => {
    assert.equal(escapeRegex('a.b'), 'a\\.b');
    assert.equal(escapeRegex('a+b'), 'a\\+b');
    assert.equal(escapeRegex('a*b'), 'a\\*b');
    assert.equal(escapeRegex('(test)'), '\\(test\\)');
    assert.equal(escapeRegex('[x]'), '\\[x\\]');
});

test('escapeRegex leaves normal characters unchanged', () => {
    assert.equal(escapeRegex('hello world'), 'hello world');
});

test('isPublicRoom returns true for public rooms', () => {
    assert.ok(isPublicRoom({ type: 'public' }));
    assert.ok(isPublicRoom({})); // defaults to public
});

test('isPublicRoom returns false for private rooms', () => {
    assert.equal(isPublicRoom({ type: 'private' }), false);
});
