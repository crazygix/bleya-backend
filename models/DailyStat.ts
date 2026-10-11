import mongoose from 'mongoose';

// The day's totals (UTC), written once shortly after the day ends by the
// analytics job (services/dailyStatsService). Unlike the raw collections, these
// don't change afterwards: deleted accounts, expired analytics events and
// expired reports don't rewrite history. They hold counts only, never personal
// data, so they are kept indefinitely. The shape of each section is
// DailyStatData in services/dailyStatsService.ts; docs/analytics.md lists the
// fields for dashboards.
const dailyStatSchema = new mongoose.Schema({
    // Midnight UTC of the day.
    day: {
        type: Date,
        required: true,
    },
    users: { type: mongoose.Schema.Types.Mixed },
    // null for days before activity tracking started.
    active: { type: mongoose.Schema.Types.Mixed, default: null },
    retention: { type: mongoose.Schema.Types.Mixed, default: null },
    signIns: { type: mongoose.Schema.Types.Mixed },
    messages: { type: mongoose.Schema.Types.Mixed },
    reports: { type: mongoose.Schema.Types.Mixed },
    blocks: { type: mongoose.Schema.Types.Mixed },
    moderation: { type: mongoose.Schema.Types.Mixed },
    contentBlocked: { type: mongoose.Schema.Types.Mixed },
    computedAt: {
        type: Date,
    },
    // The Telegram daily digest for this day (services/dailyDigestService).
    digestSentAt: {
        type: Date,
        default: null,
    },
    digestAttempts: {
        type: Number,
        default: 0,
    },
});

dailyStatSchema.index({ day: 1 }, { unique: true });

export const DailyStat = mongoose.model('DailyStat', dailyStatSchema);
