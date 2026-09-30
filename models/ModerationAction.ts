import mongoose from 'mongoose';

// Append-only audit trail of every moderator action. Written by auditService on
// each admin mutation (report status change, message delete/restore, ban/unban,
// export/erase). There are intentionally no update/delete routes — this is the
// record you show Apple/regulators to prove reports were acted on, and that
// defends you on appeals. Each entry is deleted automatically at retainUntil
// (config.auditLog.retentionDays after the action; storage limitation).
export const MODERATION_TARGET_TYPES = ['report', 'message', 'user'] as const;
export type ModerationTargetType = (typeof MODERATION_TARGET_TYPES)[number];

const moderationActionSchema = new mongoose.Schema({
    // Who performed it. With the env-key gate this is a fixed label; once an
    // admin-role login exists it becomes the moderator's user id.
    actorLabel: {
        type: String,
        required: true,
    },
    action: {
        type: String,
        required: true,
    },
    targetType: {
        type: String,
        enum: MODERATION_TARGET_TYPES,
        required: true,
    },
    targetId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
    },
    reportId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Report',
    },
    reason: {
        type: String,
        default: '',
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
    },
    retainUntil: {
        type: Date,
    },
}, {
    timestamps: true,
});

moderationActionSchema.index({ targetId: 1, createdAt: -1 });
moderationActionSchema.index({ createdAt: -1 });
moderationActionSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

export const ModerationAction = mongoose.model('ModerationAction', moderationActionSchema);
