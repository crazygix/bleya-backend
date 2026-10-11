# Analytics and alerts

Three pieces, all free:

1. **Events** in the `analyticsevents` collection: sign-in outcomes recorded by
   the backend, plus a few events the app reports (sign-in attempts that never
   reach the backend).
2. **Dashboards**: `GET /v1/admin/analytics` for a quick summary, and MongoDB
   Atlas Charts on the collections for interactive charts.
3. **Telegram moderation chat**: every new report, user block and moderator
   action (ban, suspension, message removal, report status change…).
4. **Telegram errors chat**: every server error as a copyable debug report,
   plus an hourly digest of client errors (4xx).

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

## Telegram setup

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Create two groups, e.g. "Bleya moderation" and "Bleya errors", and add the
   bot to both. Post any message in each.
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy each
   group's `message.chat.id` (negative numbers) into
   `TELEGRAM_MODERATION_CHAT_ID` and `TELEGRAM_ERRORS_CHAT_ID`.
4. Set them on Railway, redeploy, then check everything end to end:
   `curl -X POST https://api.bleyachat.com/v1/admin/alerts/test -H "x-admin-key: $ADMIN_API_KEY"`
   You should get a ✅ in the moderation group and a 🔥 test error (plus a
   client-error digest, if there were any) in the errors group.

Moderation alerts carry the report reason, ids and the moderator's reason,
never message text or other user content. A block alert also says how many
users block that person now.

## Production errors

Every `logger.error` (unhandled request errors and 500s, socket failures, push
failures, unhandled rejections, crashes…) is sent to the errors chat as a
`<pre>` block: tap it to copy, and paste it to Claude to debug. It holds the
event, time, environment, the commit that was running
(`RAILWAY_GIT_COMMIT_SHA`), the request, `requestId` / `userId`, the error and
code, the other logged fields, and the stack trace with `.ts` source lines (the
server runs with `--enable-source-maps`). The `requestId` finds the full
request in the Railway logs.

- On by default (`ERROR_ALERTS_ENABLED=false` turns it off).
- No floods: an error that keeps happening (same event, error and route, ids
  and numbers ignored) is sent once, then summarized every 10 minutes as
  "happened N more times" while it continues. At most 15 messages a minute;
  extra ones are counted and mentioned in the next message.
- On a crash the server waits up to 3 s for the alert to go out before exiting.

The code is in `utils/errorReporter.ts`, called from `utils/logger.ts`.

## Client errors (4xx)

A 4xx is the server rejecting a request: an expired token, invalid input, a
rate limit, a banned user. One at a time they're normal, so they are not sent
individually. Every `CLIENT_ERROR_DIGEST_MINUTES` (default 60) the errors chat
gets a digest grouped by route, status and error code, with a sample message,
a sample `requestId` and the clients (user agents) that hit it. Nothing is
sent when there were none.

How to read it:

- **Fix the app** when a route fails that the app should never get wrong:
  `400 VALIDATION_ERROR` / `INVALID_INPUT` on a request the app builds itself,
  `404` on an id the app just got from the API, `401` repeating for one route
  (token not refreshed before the call), `404 (no matching route)` with an app
  user agent (wrong URL).
- **Fix the backend** when the app is right and the rule is wrong: a
  validation that rejects legitimate input, a rate limit real users hit
  (`429`), an error message users can't act on.
- **Ignore**: `(no matching route)` from scanners (`/wp-login.php`…), the odd
  expired token, and `403 USER_BLOCKED` (a banned user trying).

The code is in `utils/clientErrorDigest.ts`, fed by
`middleware/httpRequestLogger.ts`.
