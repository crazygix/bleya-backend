import mongoose from 'mongoose';

export const REPORT_REASONS = [
    'spam',
    'harassment',
    'inappropriate_content',
    'impersonation',
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
    // When the report's personal data (reporter/reported ids) may be purged after
    // a referenced account is deleted. Set by the account-deletion anonymization.
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

export const Report = mongoose.model('Report', reportSchema);
