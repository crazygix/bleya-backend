import mongoose from 'mongoose';
import { ValidationError } from './errors.js';

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

export function validateObjectId(id: string, fieldName: string): mongoose.Types.ObjectId {
    if (!OBJECT_ID_REGEX.test(id)) {
        throw new ValidationError(`That ${fieldName} isn't valid.`);
    }
    return new mongoose.Types.ObjectId(id);
}

export function isValidObjectId(id: string): boolean {
    return OBJECT_ID_REGEX.test(id);
}
