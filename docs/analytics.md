# Analytics and alerts

Three pieces, all free:

1. **Events** in the `analyticsevents` collection: sign-in outcomes recorded by
   the backend, plus a few events the app reports (sign-in attempts that never
   reach the backend).
2. **Dashboards**: `GET /v1/admin/analytics` for a quick summary, and MongoDB
   Atlas Charts on the collections for interactive charts.
3. **Telegram alerts** for every new report and every moderation action (ban,
   suspension, message removal, report status change…).

## What is recorded

| Event | Source | Props | Where |
| --- | --- | --- | --- |
| `sign_in.succeeded` | server | `method` (google/apple/passkey), `isNewUser` | `routes/auth.ts` |
| `sign_in.failed` | server | `method`, `reason` (API error code), `detail` (server error message) | `routes/auth.ts` |
| `client.app.opened` | app | – | `POST /v1/analytics/events` |
| `client.sign_in.started` | app | `provider` | 〃 |
| `client.sign_in.cancelled` | app | `provider` | 〃 |
| `client.sign_in.failed` | app | `provider`, `reason` | 〃 |

Every event also has `userId` (when known), `platform`, `occurredAt`; app
events add `installId` and `appVersion`. Events are deleted automatically after
`ANALYTICS_RETENTION_DAYS` (default 90) and with the user's account.

Messages, users, reports and moderation actions are **not** duplicated as
events: dashboards read the `messages`, `users`, `reports` and
`moderationactions` collections directly.

## Mobile app

The backend can only see sign-ins that reach it. A user who closes the
Google/Apple sheet, or whose provider SDK fails, or who has no network, is
invisible unless the app reports it:

```
POST /v1/analytics/events
Authorization: Bearer <access token>   # optional; send it when signed in
{
  "installId": "<random UUID generated once per install, kept in storage>",
  "platform": "ios" | "android",
  "appVersion": "1.4.0+52",
  "events": [
    { "name": "sign_in.started",   "occurredAt": 1760000000000, "props": { "provider": "google" } },
    { "name": "sign_in.cancelled", "occurredAt": 1760000003000, "props": { "provider": "google" } },
    { "name": "sign_in.failed",    "occurredAt": 1760000003000, "props": { "provider": "apple", "reason": "network_error" } }
  ]
}
→ 202 { "accepted": 3 }
```

- Names: `app.opened`, `sign_in.started`, `sign_in.cancelled`, `sign_in.failed`.
  Unknown names and props are skipped, not rejected.
- `reason` is a short code you choose (`network_error`, `play_services_missing`,
  the SDK's error code…): letters, digits, `_ .:/-`, up to 100 characters. Never
  put emails, names or tokens in it.
- `occurredAt` is milliseconds since epoch; up to 25 events per request. It's
  fine to queue events and send them in one batch; fire-and-forget, ignore
  errors.
- When to send: `sign_in.started` when the user taps a sign-in button,
  `sign_in.cancelled` when the provider sheet is dismissed, `sign_in.failed`
  when the provider SDK throws before you call `/v1/auth/provider-sign-in`.
  A failure the backend returns is already recorded server-side; don't report
  it again. `app.opened` on cold start.

## Admin summary

```
GET /v1/admin/analytics?days=7          (x-admin-key: <ADMIN_API_KEY>, days 1–90)
```

Returns sign-ins (succeeded / failed / new accounts, by method, failure
reasons, plus the app-reported started / cancelled / failed), new and total
users, messages per city room (top 50) and in DMs, reports created / open now /
by reason, moderation actions by type, and a `daily` series (UTC days, `day` in
ms) for charts.

## Atlas Charts (interactive dashboards)

In Atlas: **Charts → Add dashboard → Add chart**, pick the cluster and the
`bleya` database. Useful charts:

- **Sign-ins per day**: collection `analyticsevents`, filter
  `{ name: { $in: ["sign_in.succeeded", "sign_in.failed"] } }`, X = `occurredAt`
  (binned by day), Y = count, series = `name`.
- **Why sign-ins fail**: same collection, filter `{ name: "sign_in.failed" }`,
  bar chart of `props.reason`, series `props.method`.
- **Sign-in funnel from the app**: filter `{ name: /^client\.sign_in/ }`,
  count by `name` and `props.provider`.
- **Messages per city**: collection `messages`, add a lookup on `roomId` →
  `rooms._id`, bar chart of `room.name`, filter `room.type = "public"`.
- **New users per day**: collection `users`, X = `createdAt` by day.
- **Reports**: collection `reports`, count by `reason` / `status`.
- **Bans and other actions**: collection `moderationactions`, count by `action`
  over `createdAt`.

Dashboards refresh on their own and support filters (date range, city) on
the dashboard.

## Telegram alerts

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot (or add it to a group and post there).
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy
   `result[].message.chat.id` into `TELEGRAM_CHAT_ID` (group ids are negative).
4. Set both on Railway and redeploy.

Alerts carry the report reason, the target's id and the moderator's reason,
never message text or other user content.
