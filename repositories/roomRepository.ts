import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import type { LeanRoom } from '../types/lean.js';

export interface RoomRepository {
    findById(id: mongoose.Types.ObjectId, select?: string): Promise<LeanRoom | null>;
    findPublicRooms(filter: Record<string, unknown>, select?: string): Promise<LeanRoom[]>;
    countByFilter(filter: Record<string, unknown>): Promise<number>;
}

export class MongoRoomRepository implements RoomRepository {
    async findById(id: mongoose.Types.ObjectId, select?: string) {
        let query = Room.findById(id);
        if (select) {
            query = query.select(select);
        }
        return query.lean<LeanRoom | null>();
    }

    async findPublicRooms(filter: Record<string, unknown>, select?: string) {
        let query = Room.find(filter).sort({ name: 1 });
        if (select) {
            query = query.select(select);
        }
        return query.lean<LeanRoom[]>();
    }

    async countByFilter(filter: Record<string, unknown>) {
        return Room.countDocuments(filter);
    }
}

export const roomRepository: RoomRepository = new MongoRoomRepository();
