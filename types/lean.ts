import mongoose from 'mongoose';

export interface GeoPoint {
    type?: 'Point';
    coordinates?: number[];
}

export interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    description?: string;
    type?: 'public' | 'private';
    participants?: mongoose.Types.ObjectId[];
    participantsHash?: string;
    cityKey?: string;
    imageUrl?: string;
    geo?: GeoPoint;
}

export interface LeanMessage {
    _id: mongoose.Types.ObjectId;
    roomId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    text: string;
    createdAt: Date;
    parentMessageId?: mongoose.Types.ObjectId | null;
    replyCount?: number;
}

export interface LeanUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
    bio?: string;
    profileImageUrl?: string;
}

export interface LeanFullUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
    bio?: string;
    profileImageUrl?: string;
    createdAt: Date;
    updatedAt: Date;
    lastLogin: Date;
}

export interface LeanUserBlock {
    _id?: mongoose.Types.ObjectId;
    blockerUserId: mongoose.Types.ObjectId;
    blockedUserId: mongoose.Types.ObjectId;
    roomId?: mongoose.Types.ObjectId;
    isActive?: boolean;
    blockedAt?: Date;
}

export interface RoomReadPointer {
    roomId: mongoose.Types.ObjectId;
    lastReadAt?: Date | null;
}

export interface LeanJoinedRoomsUser {
    _id?: mongoose.Types.ObjectId;
    joinedRooms: mongoose.Types.ObjectId[];
    hiddenDirectRooms?: mongoose.Types.ObjectId[];
    roomReadPointers?: RoomReadPointer[];
}

export interface LastMessageAgg {
    _id: mongoose.Types.ObjectId;
    lastMessageText?: string;
    lastMessageTime?: Date;
    lastMessageUserId?: mongoose.Types.ObjectId;
}
