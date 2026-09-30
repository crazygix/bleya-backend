import mongoose from 'mongoose';

export const REPORT_REASONS = [
    'spam',
    'harassment',
    'inappropriate_content',
    'impersonation',
    // The user appears to be under the minimum age (15).
    'underage',
    'other',
] as const;

export const REPORT_STATUSES = ['open', 'reviewed', 'actioned', 'dismissed'] as const;

const reportSchema = new mongoose.Schema({
    reporterUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    // At least one target is required (enforced in the service): a user and/or a
    // specific message and/or a room.
    reportedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
    },
    messageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
    },
    // Copy of the reported message taken when the report is filed. Messages are
    // hard-deleted with their author's account, so without this the evidence
    // for a report could vanish before a moderator looks at it.
    messageSnapshot: {
        text: { type: String },
        authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        authorUsername: { type: String },
        createdAt: { type: Date },
    },
    reason: {
        type: String,
        enum: REPORT_REASONS,
        required: true,
    },
    details: {
        type: String,
        default: '',
    },
    status: {
        type: String,
        enum: REPORT_STATUSES,
        default: 'open',
    },
    // Set when a moderator handles the report via the admin API. reviewedBy holds
    // the actor label (env-key actor today; a moderator user id later).
    reviewedBy: {
        type: String,
        default: '',
    },
    reviewedAt: {
        type: Date,
    },
    resolutionNote: {
        type: String,
        default: '',
    },
    // When the report (and its message copy) is deleted, by the TTL index
    // below. Set on creation to config.reports.retentionDays after filing.
    retainUntil: {
        type: Date,
    },
}, {
    timestamps: true,
});

// Moderation queue: newest open reports first.
reportSchema.index({ status: 1, createdAt: -1 });
// Surface repeat-reported users.
reportSchema.index({ reportedUserId: 1, status: 1 });
// Storage limitation: MongoDB deletes each report once retainUntil passes.
reportSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

export const Report = mongoose.model('Report', reportSchema);
