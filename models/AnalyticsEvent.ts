import mongoose from 'mongoose';

// Product analytics events, for dashboards (e.g. MongoDB Atlas Charts) and the
// admin summary at GET /v1/admin/analytics. `server` events are recorded by the
// backend itself (sign-in outcomes); `client` events are reported by the app
// through POST /v1/analytics/events (things the backend never sees, such as a
// sign-in the user cancelled in the Google/Apple sheet). Props hold only
// allowlisted, non-content fields. Each event is deleted automatically at
// retainUntil (config.analytics.retentionDays after it happened), and with the
// user's account.
export const ANALYTICS_EVENT_SOURCES = ['server', 'client'] as const;
export type AnalyticsEventSource = (typeof ANALYTICS_EVENT_SOURCES)[number];

const analyticsEventSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    source: {
        type: String,
        enum: ANALYTICS_EVENT_SOURCES,
        required: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    // Random per-install id the app generates, so a signed-out funnel
    // (started -> cancelled/failed -> succeeded) can be followed.
    installId: {
        type: String,
    },
    platform: {
        type: String,
    },
    appVersion: {
        type: String,
    },
    props: {
        type: mongoose.Schema.Types.Mixed,
    },
    // When it happened (client events may arrive batched, a little later).
    occurredAt: {
        type: Date,
        required: true,
    },
    retainUntil: {
        type: Date,
    },
}, {
    timestamps: { createdAt: true, updatedAt: false },
});

analyticsEventSchema.index({ name: 1, occurredAt: -1 });
analyticsEventSchema.index({ occurredAt: -1 });
analyticsEventSchema.index({ userId: 1 });
analyticsEventSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

export const AnalyticsEvent = mongoose.model('AnalyticsEvent', analyticsEventSchema);
