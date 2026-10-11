# Atlas Charts dashboard

A click-by-click guide to an interactive dashboard over the `dailystats` collection (one document per finished
UTC day, see `docs/analytics.md`). It takes about half an hour. Every query and formula below was run against
`dailystats` documents written by the backend's own rollup.

## Before you start

- Sign in to Atlas with the **Project Owner** role on the Bleya project. Other roles can build charts, but only an
  owner can fix data-source access.
- What the cluster tier changes: on the free **M0** tier a dashboard refreshes at most every 4 hours, there is no
  manual refresh, and you get one weekly emailed report per project. On **Flex** and **M10+** it refreshes as
  often as every minute and you can email daily reports. Charts costs nothing extra on either.
- `dailystats` appears about a minute after the new backend first starts, filled in for up to the last 90 days.
  It only holds finished UTC days. Today's numbers so far are only in `GET /v1/admin/analytics` (the live
  summary, needs `x-admin-key`); the morning Telegram digest repeats yesterday's `dailystats` document.
- Labels below come from MongoDB's documentation; the live UI may word a few of them slightly differently.

## 1. Create the dashboard

1. Open [cloud.mongodb.com](https://cloud.mongodb.com), pick the organization and the Bleya project in the top
   bar, then in the left sidebar under **Services** click **Visualization** (in the older layout, the **Charts**
   tab at the top). The first visit sets Charts up for the project.
2. **Project Dashboards** → **Add Dashboard** → Title `Bleya` → **Save**.
3. Charts connects to every cluster in the project by default. If `dailystats` is missing when you pick the data
   source (section 3, step 1), check **Data Sources** (under Settings in the Charts sidebar): the cluster and the `bleya` database must be
   **Connected**.

## 2. One date range for every chart

On the dashboard: **Dashboard Filters** → **Add Filters** → expand the `dailystats` data source → drag `day` onto
**+ filter** → choose **Period**, **Previous 30 Day**, turn **Include current period** off (today has no totals
yet) → **Apply Filters**. Every chart then follows this range, and each viewer can change it for themselves.

## 3. How every chart is built

1. On the dashboard, **Add Chart**. In **Select Data Source** open the **Project** tab, click the cluster, then
   `bleya`, then **Select** on `dailystats`.
2. Pick the **Chart Type**, then drag fields from the **Fields** pane onto the channels of the **Encode** tab.
   Objects show as `{}` and arrays as `[]`; click the arrow to open them.
3. **Time axis** (charts over days): drag `day` to the **X Axis**, keep **Binning** on, choose
   **Date of the Month** and leave **Periodic** off: one point per day. For weekly or monthly points use
   **Week of Year** or **Month**, still with Periodic off.
4. Give fields readable names under **Customize** → **Fields** → **Label Override**. Leave **Convert Time Zone**
   off: `day` is midnight UTC and converting can move it to the evening before.
5. If a field isn't in the Fields pane (the pane is built from a sample of documents, so newer fields such as
   `signIns.installs` may be missing): **Add Field** (the + in the pane) → **Missed** → type the dotted name,
   e.g. `signIns.installs.signedIn` → **Save Field**.
6. Type a title, **Save and close**, then drag the chart into place and resize it from its corner.

Where a chart says **Query bar**, paste the text into the bar above the chart and click **Apply**.

**Days before tracking.** The first deploy backfilled up to 90 days from the other collections. For days before
tracking started (the first day where `active` is not null), `users`, `messages`, `reports`, `blocks` and
`moderation` are real, but `active` and `retention` are null and everything that comes from `analyticsevents`
(`signIns.*`, `contentBlocked.*`) is 0 because nothing was recorded yet. Charts below that use those fields put
`{ "active": { "$ne": null } }` in the Query bar so those days don't read as "nobody signed in".

## 4. The charts

### Number tiles (top row)

Chart Type **Text** → **Number**, one tile each, over the dashboard's date range:

| Tile | Number field | Aggregate |
|---|---|---|
| New users | `users.new` | sum |
| Messages | `messages.total` | sum |
| Sign-ins the server rejected | `signIns.failed` | sum, with the Query bar `{ "active": { "$ne": null } }` |
| Sign-ins that failed in the app | `signIns.client.failed` | sum, with the same Query bar |
| New reports | `reports.created` | sum |
| Active users yesterday | `active.users` | max, with a chart filter (**Filter** tab) on `day`: Period, Previous 1 Day, current period off |

### 1. Active users

- **Line** → **Discrete Line**. X Axis: `day` (step 3).
- Y Axis: `active.users`, then `active.last7Days`, then `active.last30Days`, each with Aggregate **max**. Each
  field adds its own line. Labels: Active that day, Active in 7 days, Active in 30 days.
- Query bar: `{ "active": { "$ne": null } }` (days before tracking started have `active: null`; this keeps them
  off the axis, so the lines start on the first tracked day).
- Use max or mean, never sum: with weekly bins, sum would add days together.
- The first tracked day is partial (tracking began at the deploy). `Active in 7 days` only becomes a full 7-day
  count 7 days later, and `Active in 30 days` 30 days later; until then they rise because the window is filling,
  not because of growth.

### 2. Active users by platform

- **Area** → **Discrete Area** (it stacks the series; not 100% Stacked Area). X Axis: `day` with the **Date of the Month** bin only (a weekly bin
  would add days together).
- Y Axis: `active.byPlatform.count`, Array Reductions **Unwind array**, Aggregate **sum**.
- Series: `active.byPlatform.key`, Array Reductions **Unwind array**.
- Query bar: `{ "active": { "$ne": null } }` (this chart sums the unwound array, so without it the days before
  tracking would show as 0).

### 3. Sign-ins per day

- **Column** → **Stacked**. X Axis: `day`.
- Query bar: `{ "active": { "$ne": null } }`.
- Y Axis: `signIns.succeeded` (sum), then `signIns.failed` (sum), then `signIns.client.failed` (sum). Labels
  Succeeded, Rejected by the server and Failed in the app; colours under Customize.
- `signIns.failed` only counts attempts the server answered. Attempts that never reached it (offline, timeouts,
  the server down, a Google/Apple/passkey error on the phone) are `signIns.client.failed`, so during an outage
  the server column drops to 0 while the app column rises.
- Optional failure rate on the same chart: switch to **Combo** → **Stacked**, keep the three fields in
  **Columns**, add a calculated field (**Add Field** → **Calculated**) named `failRate` with this Value
  Expression (all failures, server and app), put it in **Lines** with Aggregate **mean**, and turn on the
  secondary Y axis for it under Customize → Fields:

  ```
  { "$cond": [ { "$gt": [ { "$add": ["$signIns.succeeded", "$signIns.failed", "$signIns.client.failed"] }, 0 ] }, { "$multiply": [ { "$divide": [ { "$add": ["$signIns.failed", "$signIns.client.failed"] }, { "$add": ["$signIns.succeeded", "$signIns.failed", "$signIns.client.failed"] } ] }, 100 ] }, null ] }
  ```

  Daily bins only: the mean of daily rates is not a weekly rate.

### 4. Did people get in?

- **Column** → **Stacked**. X Axis: `day`, **Date of the Month** bin only.
- Query bar: `{ "active": { "$ne": null } }`.
- Y Axis: `signIns.installs.signedIn` (sum), label Got in; then `signIns.installs.neverSignedIn` (sum), label
  Didn't get in. Together they are every install that tried to sign in that day.
- To see how many of those hit an error, switch to **Combo** → **Stacked**, keep the two in **Columns** and add
  `signIns.installs.neverSignedInAfterError` (sum) to **Lines**.
- These are installs per day, so keep daily bins and don't put them in tiles. An install that tries on several
  days is counted on each of them, and one that failed on Monday and got in on Tuesday is "Didn't get in" on
  Monday and "Got in" on Tuesday; a weekly sum would count it twice.
- These count only app builds that send the install ID (the first build after 1.0.0+12 and later); sign-ins from
  older builds show in `signIns.attemptsWithoutInstallId`.

### 5. Why sign-ins fail

- **Bar** → **Stacked**.
- Query bar (starts with the days-before-tracking filter, then combines the reasons the server saw and the ones the app reported, keeps `day` for the date range):

  ```
  [ { "$match": { "active": { "$ne": null } } }, { "$project": { "day": 1, "r": { "$concatArrays": [ { "$map": { "input": { "$ifNull": ["$signIns.failureReasons", []] }, "as": "x", "in": { "source": "server", "key": "$$x.key", "count": "$$x.count" } } }, { "$map": { "input": { "$ifNull": ["$signIns.client.failureReasons", []] }, "as": "x", "in": { "source": "app", "key": "$$x.key", "count": "$$x.count" } } } ] } } }, { "$unwind": "$r" }, { "$project": { "day": 1, "source": "$r.source", "reason": "$r.key", "count": "$r.count" } } ]
  ```

- Y Axis: `reason`. X Axis: `count`, Aggregate **sum**. Series: `source`.
- Sort By **Value**, descending; **Limit Results** on, Show 10.
- Reasons: server codes such as `UNAUTHORIZED` (the Google/Apple token was rejected, or the passkey is unknown),
  `USER_BLOCKED` (banned or suspended) and `TOO_MANY_REQUESTS` (rate limit); app codes such as `network:networkError`, `apple:failed` and
  `passkey:noCredentials`. Closing the Google/Apple sheet isn't a failure; it is counted as a cancel.

### 6. Messages per city

- **Bar** → **Grouped**.
- Y Axis: `messages.byCity.name`, Array Reductions **Unwind array**.
- X Axis: `messages.byCity.messages`, Array Reductions **Unwind array**, Aggregate **sum**.
- Sort By **Value**, descending; **Limit Results** on, Show 15, tick **Show "All others"**.
- If the two unwound fields don't stay paired (bars look wrong), use this Query bar instead and chart Y = `city`,
  X = `messages` (sum):

  ```
  [ { "$unwind": "$messages.byCity" }, { "$project": { "day": 1, "city": "$messages.byCity.name", "messages": "$messages.byCity.messages" } } ]
  ```

### 7. New users, and how many of the previous day's sign-ups came back

- **Combo** → **Grouped**. X Axis: `day`.
- Columns: `users.new` (sum), label New users.
- Add a calculated field `day1Rate` with this Value Expression, put it in **Lines** with Aggregate **mean**,
  and turn on the secondary Y axis for it (number format suffix `%`):

  ```
  { "$cond": [ { "$gt": [ "$retention.day1.signups", 0 ] }, { "$multiply": [ { "$divide": [ "$retention.day1.returned", "$retention.day1.signups" ] }, 100 ] }, null ] }
  ```

- How to read it: on each day, the share of the previous day's sign-ups who used the app that day. The line and
  the column on the same date are different people: the column is that day's new users, the line is about the
  day before's. The same works for `retention.day7` and `retention.day30` (sign-ups 7 or 30 days earlier).
- Daily bins only: the mean of daily rates is not a weekly rate. For a true weekly rate, use this Query bar and
  chart X = `week` (Date of the Month, Periodic off), Columns `newUsers` (sum), Lines `rate` (mean):

  ```
  [ { "$group": { "_id": { "$dateTrunc": { "date": "$day", "unit": "week", "startOfWeek": "monday", "timezone": "UTC" } }, "newUsers": { "$sum": "$users.new" }, "signups": { "$sum": "$retention.day1.signups" }, "returned": { "$sum": "$retention.day1.returned" } } }, { "$project": { "_id": 0, "week": "$_id", "newUsers": 1, "rate": { "$cond": [ { "$gt": ["$signups", 0] }, { "$multiply": [ { "$divide": ["$returned", "$signups"] }, 100 ] }, null ] } } } ]
  ```

  Each week's rate covers sign-ups from the Sunday before to the Saturday. Set the dashboard range to whole weeks
  (Period → **Previous N Week**), or the first and last bars are partial weeks.

### 8. Safety per day

- **Column** → **Grouped**. X Axis: `day`.
- Y Axis: `reports.created`, `blocks.created`, `moderation.actions`, `contentBlocked.total`, each sum. Labels
  Reports, Blocks, Moderator actions, Filter blocks.
- Filter blocks are 0 before tracking started; add the Query bar `{ "active": { "$ne": null } }` if the range
  reaches back that far.
- If filter blocks dwarf the rest, give them their own chart.

### 9. What the reports and actions are about

Three **Bar** → **Grouped** charts, each sorted by Value descending:

| Chart | Y Axis (Unwind array) | X Axis (Unwind array, sum) |
|---|---|---|
| Reports by reason | `reports.byReason.key` | `reports.byReason.count` |
| Moderator actions | `moderation.byAction.key` | `moderation.byAction.count` |
| Filter blocks by field | `contentBlocked.bySurface.key` | `contentBlocked.bySurface.count` |

## 5. Share it and get it by email

- **Share** (dashboard, top right) → **Project** tab → add people as Viewer or Author, or turn on everyone in
  the project. Viewers also need a project role that can read the database.
- **Schedule** → **New Report**: name it (it is the email subject), add recipients, attach a PDF, then on
  **Schedule** set the start, **Frequency** (Weekly on M0; Daily or Weekly on Flex and M10+), the time zone
  `Europe/Belgrade` and a time such as 08:00 → **Schedule**. Only the dashboard's owner can do this.
- Refresh (Flex and M10+ only; on M0 it is fixed at 4 hours): the Refresh icon → **Automatic refresh** → pick how
  stale it may get (the 1-hour default is fine; the data changes once a day) → **Save**. This setting is kept per
  browser.

## Things to know

- Days are UTC: a day in `dailystats` runs 01:00–01:00 (02:00–02:00 in summer) in Serbia.
- Sum is right for counts of events over several days (new users, messages, sign-in attempts, reports, blocks). It
  is not right for people per day (`active.*`, `signIns.installs.*`) or rates: use max or mean with daily bins, or
  the weekly query above.
- Tracking started on the first day with a `useractivities` record (the October 11, 2026 deploy). Before it,
  `active` and `retention` are null and `signIns.*` and `contentBlocked.*` are 0 (see "Days before tracking"
  above); that first day is partial.
- A written day never changes, so deleted accounts don't lower past numbers.
- For a one-off look at raw events, chart `analyticsevents` (e.g. Query bar `{ "name": "sign_in.failed" }`, a Bar
  of `props.reason`), but keep dashboards on `dailystats`: it is small, fast and never hits Charts' 5,000-result
  limit.
