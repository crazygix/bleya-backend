import mongoose, { Schema, Document } from 'mongoose';

// Document<string>: cities use their slug as _id, not an ObjectId.
export interface ICity extends Document<string> {
    _id: string; // City slug (e.g., "paris-fr")
    name: string; // "Paris"
    country: string; // "FR"
    countryName: string; // "France"
    location: {
        type: 'Point';
        coordinates: [number, number]; // [lng, lat] GeoJSON
    };
    imageUrl?: string; // R2 URL (lazy-loaded)
    imageCheckedAt?: Date | null; // Last image lookup attempt (limits retries)
    population?: number;
    lastUpdated: Date;
}

const CitySchema = new Schema<ICity>({
    _id: { type: String, required: true },
    name: { type: String, required: true },
    country: { type: String, required: true },
    countryName: { type: String, required: true },
    location: {
        type: { type: String, enum: ['Point'], required: true },
        coordinates: { type: [Number], required: true },
    },
    imageUrl: { type: String },
    imageCheckedAt: { type: Date, default: null },
    population: { type: Number },
    lastUpdated: { type: Date, default: Date.now },
});

CitySchema.index({ location: '2dsphere' });
CitySchema.index({ name: 'text', countryName: 'text' });

export const City = mongoose.model<ICity>('City', CitySchema);
