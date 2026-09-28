import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import type { LeanRoom } from '../types/lean.js';

export interface RoomRepository {
    findById(id: mongoose.Types.ObjectId, select?: string): Promise<LeanRoom | null>;
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

    async countByFilter(filter: Record<string, unknown>) {
        return Room.countDocuments(filter);
    }
}

export const roomRepository: RoomRepository = new MongoRoomRepository();
