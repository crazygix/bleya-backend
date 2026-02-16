import mongoose, { Schema, Document } from 'mongoose';

export interface ICity extends Document {
    _id: string; // City slug (e.g., "paris-fr")
    name: string; // "Paris"
    country: string; // "FR"
    countryName: string; // "France"
    location: {
        type: 'Point';
        coordinates: [number, number]; // [lng, lat] GeoJSON
    };
    imageUrl?: string; // R2 URL (lazy-loaded)
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
    population: { type: Number },
    lastUpdated: { type: Date, default: Date.now },
});

CitySchema.index({ location: '2dsphere' });
CitySchema.index({ name: 'text', countryName: 'text' });

export const City = mongoose.model<ICity>('City', CitySchema);
