import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    description: {
        type: String,
    },
    type: {
        type: String,
        enum: ['public', 'private'],
        default: 'public',
    },
    participants: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'User',
        default: [],
    },
    participantsHash: {
        type: String, // Unique identifier for private chats (sorted participant IDs joined)
        sparse: true, // Only for private chats
    },
    cityKey: {
        type: String,
        trim: true,
        lowercase: true,
        sparse: true,
    },
    imageUrl: {
        type: String,
        default: '',
    },
    geo: {
        type: {
            type: String,
            enum: ['Point'],
        },
        coordinates: {
            type: [Number],
            validate: {
                validator: function (coords: number[] | undefined): boolean {
                    if (!coords || coords.length === 0) {
                        return true;
                    }

                    if (coords.length !== 2) {
                        return false;
                    }

                    const [longitude, latitude] = coords;
                    return Number.isFinite(longitude)
                        && Number.isFinite(latitude)
                        && longitude >= -180
                        && longitude <= 180
                        && latitude >= -90
                        && latitude <= 90;
                },
                message: 'Geo coordinates must be [longitude, latitude]',
            },
        },
    },
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
});

// NOTE: MongoDB rejects `sparse` combined with `partialFilterExpression`, so
// none of these may set `sparse` (it silently kept every one of them from being
// built). Public room names are deliberately not unique: seeded rooms and city
// rooms can share a display name ("Belgrade, Serbia").

// Unique index for private rooms by participantsHash (ensures only one DM between two users)
// This properly prevents duplicate DMs unlike indexing the array field directly
roomSchema.index(
    { participantsHash: 1, type: 1 },
    { unique: true, partialFilterExpression: { type: 'private', participantsHash: { $type: 'string' } } }
);

// Stable unique identity for public city rooms discovered from external providers
roomSchema.index(
    { cityKey: 1, type: 1 },
    { unique: true, partialFilterExpression: { type: 'public', cityKey: { $type: 'string' } } }
);

// Enables geo-radius lookups for nearby public city rooms
roomSchema.index(
    { geo: '2dsphere' },
    { partialFilterExpression: { type: 'public', 'geo.type': 'Point' } }
);

export const Room = mongoose.model('Room', roomSchema);
