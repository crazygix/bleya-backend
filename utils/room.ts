import type { GeoPoint, LeanRoom } from '../types/lean.js';

export interface RoomLocation {
    latitude: number;
    longitude: number;
}

export function toRoomLocation(room: { geo?: GeoPoint }): RoomLocation | null {
    const coordinates = room.geo?.coordinates;
    if (!coordinates || coordinates.length < 2) {
        return null;
    }

    const [longitude, latitude] = coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return null;
    }

    return { latitude, longitude };
}

export function isPrivateRoomParticipant(
    room: Pick<LeanRoom, 'type' | 'participants'>,
    userId: string
): boolean {
    if ((room.type || 'public') !== 'private') {
        return true;
    }

    return (room.participants || []).some(
        (participantId) => participantId.toString() === userId
    );
}
