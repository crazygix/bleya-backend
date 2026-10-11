# Analytics and alerts

All of it lives in the backend and the database; nothing goes to a third party.

1. **Events** (`analyticsevents`): sign-in outcomes, content the filter
   rejected, and what the app reports (app opened, sign-ins that never reach
   the backend).
2. **Daily activity** (`useractivities`): one record per user per day they used
   the app, for active users and returning users.
3. **Daily totals** (`dailystats`): each finished UTC day's numbers, written
   once and kept indefinitely. These are what dashboards should chart.
4. **Admin API**: `GET /v1/admin/analytics` (live summary) and
   `GET /v1/admin/analytics/daily` (the daily totals).
5. **Telegram**: a moderation chat (reports, users many people block, moderator
   actions), an errors chat (every server error) and a daily digest.

## What the app sends with every request

| Header | Example | Used for |
| --- | --- | --- |
| `X-App-Platform` | `ios`, `android` | splitting sign-ins and active users by platform |
| `X-App-Version` | `1.0.0+13` | which builds are in use, and where failures come from |
| `X-Install-Id` | random UUID | counting sign-in attempts per person (see below) |

The install id is created on first launch and kept in a file in the app's own
storage, so uninstalling removes it; it isn't tied to the device or the account.
The socket handshake carries the same headers. Builds from before the headers
count as `unknown`. Code: `utils/clientContext.ts`.

## Events

| Event | Source | Props |
| --- | --- | --- |
| `sign_in.succeeded` | server (`routes/auth.ts`) | `method` (google/apple/passkey), `isNewUser` |
| `sign_in.failed` | server (`routes/auth.ts`) | `method`, `reason` (API error code), `detail` (server message) |
| `moderation.content_blocked` | server | `surface` (message/username/bio/profile_photo), `kind` (text/image) |
| `client.app.opened` | app | – |
| `client.sign_in.started` | app | `provider` |
| `client.sign_in.cancelled` | app | `provider` |
| `client.sign_in.failed` | app | `provider`, `reason` |

Every event has `occurredAt`, and `userId`, `platform`, `appVersion` and
`installId` when known. A sign-in the rate limiter refused (429) is recorded as
`sign_in.failed` with reason `TOO_MANY_REQUESTS`, once per install (or IP) per
15 minutes. A content-filter event never holds the text or image.

### What the app reports

The backend only sees sign-ins that reach it, so the app (bleya-mobile:
`AuthController` and `utils/sign_in_analytics.dart`) reports:

- `sign_in.started` when a sign-in button is tapped;
- `sign_in.cancelled` when the Google/Apple/passkey sheet is closed;
- `sign_in.failed` when the provider's SDK fails (`google:clientConfigurationError`,
  `apple:failed`, `passkey:domainNotAssociated`…) or the request never got an
  answer (`network:networkError`, `network:connectionTimeout`, `http:502`).
  Failures the backend answered are left out; the server already recorded them;
- `app.opened` on every cold start.

```
POST /v1/analytics/events            (Authorization optional, X-App-* headers)
{ "events": [ { "name": "sign_in.started", "occurredAt": 1760000000000, "props": { "provider": "google" } } ] }
→ 202 { "accepted": 1 }
```

Unknown names and props are dropped, at most 25 events per request, and
`installId` / `platform` / `appVersion` may also be sent in the body. The app
sends them in batches a couple of seconds after they happen and retries a few
times when offline.

### People, not attempts

`signIns.installs` counts installs rather than attempts:
`openedSignedOut` (opened the app while signed out), `tried` (any sign-in
event), `signedIn`, `neverSignedIn` and `neverSignedInAfterError` (never got in
and saw at least one error; the rest gave up). `attemptsWithoutInstallId` counts
server sign-in events from builds without the header, which these numbers miss.

## Active users

Each authenticated request, socket connection and sign-in marks the user active
for the UTC day (one write per user per day, `services/activityService.ts`),
with the platform and version of the day's first request. That gives daily,
weekly (7 days) and monthly (30 days) active users, and how many new users come
back 1, 7 and 30 days after signing up.

Sign-ins are not usage: a session lasts 365 days, so most people sign in once
per install. Use active users for usage.

## Daily totals (`dailystats`)

Every 10 minutes the server writes the totals of any finished UTC day that has
none yet (`services/dailyStatsService.ts`, started from `server/server.ts`). On
the first deploy it fills in the last `ANALYTICS_BACKFILL_DAYS` (default 90),
from the first account on. A written day never changes, so deleted accounts,
expired events and expired reports don't rewrite history. They hold counts only
(and city room names), so they are kept indefinitely. One document per day:

| Field | What |
| --- | --- |
| `day` | midnight UTC |
| `users` | `new`, `total` (accounts at the end of the day that still exist) |
| `active` | `users` (that day), `last7Days`, `last30Days`, `byPlatform`; null before tracking started |
| `retention` | `day1` / `day7` / `day30`: `{ signups, returned }`, sign-ups from that many days before who used the app this day |
| `signIns` | `succeeded`, `failed`, `newAccounts`, `byMethod`, `byPlatform`, `failureReasons`, `client` (started/cancelled/failed/failureReasons), `installs`, `attemptsWithoutInstallId` |
| `messages` | `total`, `inCityRooms`, `inDirectMessages`, `byCity` (`name`, `cityKey`, `messages`, up to 500 cities) |
| `reports` | `created`, `byReason` |
| `blocks` | `created` |
| `moderation` | `actions`, `byAction` (bans, suspensions, removals…) |
| `contentBlocked` | `total`, `bySurface` |

Counts include messages that moderators later removed.

## Admin API

```
GET /v1/admin/analytics?days=7           live summary, days 1–90, today included
GET /v1/admin/analytics/daily?days=30    written daily totals, days 1–366, oldest first
(x-admin-key: <ADMIN_API_KEY>)
```

The summary has everything in a daily total for the whole period, plus total
users, reports open now, active users today / in the last 7 and 30 days, and a
`daily` series. Times are in ms.

## Atlas Charts (interactive dashboards)

In Atlas: **Charts → Add dashboard → Add chart**, pick the cluster, the `bleya`
database and mostly the `dailystats` collection (one document per day, so
charts are fast and stable). Useful charts:

- **Active users**: line, X = `day`, Y = `active.users`, `active.last7Days`, `active.last30Days`.
- **Sign-ins**: stacked columns, X = `day`, Y = `signIns.succeeded` and `signIns.failed`.
- **Did people get in**: X = `day`, Y = `signIns.installs.signedIn` and `signIns.installs.neverSignedIn`.
- **Why sign-ins fail**: unwind `signIns.failureReasons` (and `signIns.client.failureReasons`), sum `count` by `key`.
- **Messages per city**: unwind `messages.byCity`, sum `messages` by `name`, with a date filter on `day`.
- **New users and returns**: `users.new`, `retention.day1.returned` / `retention.day1.signups`.
- **Safety**: `reports.created`, `blocks.created`, `moderation.actions`, `contentBlocked.total` per day.

For today, or a drill-down into single events, chart `analyticsevents`
(e.g. filter `{ name: "sign_in.failed" }`, bar of `props.reason`). Dashboards
support date-range filters and can email scheduled reports.

## Telegram

### Setup

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Create the groups, e.g. "Bleya moderation" and "Bleya errors" (and "Bleya
   stats" if the digest should go elsewhere), add the bot and post any message
   in each.
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy each group's
   `message.chat.id` (negative numbers) into `TELEGRAM_MODERATION_CHAT_ID`,
   `TELEGRAM_ERRORS_CHAT_ID` and, optionally, `TELEGRAM_DIGEST_CHAT_ID`.
4. Set them on Railway, redeploy, then check everything end to end:
   `curl -X POST https://api.bleyachat.com/v1/admin/alerts/test -H "x-admin-key: $ADMIN_API_KEY"`
   You should get a ✅ in the moderation group (and the digest group) and a 🔥
   test error in the errors group.

### Moderation chat

Every new report and moderator action (ban, suspension, message removal,
report status change…). A block is alerted only when the number of people
blocking that user reaches 3, 5, 10, 25, 50 or 100 (then every 100). Alerts
carry reasons and ids, never message text or other user content.

### Daily digest

At `DAILY_DIGEST_HOUR_UTC` (default 6, i.e. 7–8 in Serbia) the server sends
yesterday's (UTC) numbers to `TELEGRAM_DIGEST_CHAT_ID`, or to the moderation
chat when that is unset: new and total users, active users, returning new users,
sign-ins with failure reasons and the app's side, people who never got in,
messages with the top cities, reports, blocks, moderator actions and content
the filter blocked. It is sent once per day; a failed send is retried up to 3
times. `DAILY_DIGEST_ENABLED=false` turns it off.

### Production errors

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

App crashes are reported by Firebase Crashlytics in the app, which emails new
and returning crashes; they don't come here.

### Client errors (4xx)

Not sent to Telegram. A 4xx is the server rejecting a request (expired token,
invalid input, rate limit, banned user); they are mostly expected, so they
are only logged (as `request.error` warnings and `http.request.finish` with the
status) and can be searched in the Railway logs.

## Personal data

Events and activity records are tied to the account when the user is signed in,
deleted `ANALYTICS_RETENTION_DAYS` (default 90) after they happen, deleted with
the account, and included in the data export (`usage` in
`GET /v1/users/me/export`). The daily totals hold no personal data. The App
Store and Google Play privacy answers and the privacy policy must describe this
collection (usage data, the install id, crash data) before a build that sends
it is released.

## Deploying

Run `npm run migrate:analytics-indexes` once against production: it builds the
`createdAt` / `blockedAt` indexes the counts use on the existing collections.
