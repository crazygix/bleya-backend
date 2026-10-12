---
name: wipe-env
description: Wipe the Bleya backend environment clean — local dev, production, or both. Drops all Mongo collections (keeping cities by default) and empties the R2 image bucket via scripts/db.ts. Use when the user asks to wipe, reset, clean or start fresh on the database, dev or prod.
---

# Wipe Bleya environment

Everything goes through `scripts/db.ts` (`npm run db`). Menu:
- `1` Clean database: drops every collection, then asks "Also drop the cities collection?" and "Also empty the R2 bucket?"
- `2` Import cities from `data/cities.json` (upsert)
- `3` Empty R2 bucket: deletes every object in `R2_BUCKET_NAME` and keeps the bucket

Emptying R2 (option `3`, or `y` to the R2 question in `1`) also clears `imageUrl`/`imageCheckedAt` on every city. City images live in R2, and cities only fetch a new image when `imageUrl` is empty.

## Rules

- **Ask which target if unclear**: local, prod, or both.
- **Keep `cities`** (answer `N`) unless the user says otherwise. If dropped, re-import with option `2`.
- **Prod needs an explicit go-ahead in the current conversation**, even if the user asked for this before. Before deleting, show the host, database and bucket, plus the current collection counts.
- Never print credentials. Mask URIs with `sed -E 's#(://)[^@/]+@#\1***@#g'`.
- R2 has no backup. Say so before emptying a prod bucket.

## Driving the interactive script

`ask()` opens a new readline for each question, so piping all the answers at once loses input. Feed the answers with sleeps in between:

```
(sleep 3; echo 1; sleep 6; echo <db-confirm>; sleep 2; echo N; sleep 2; echo y; sleep 8; echo <bucket>; sleep 60) | <runner> 2>&1 | grep -v -E '^\s*$'
```

- `<db-confirm>`: `y` for localhost; for a non-local or production database, type the database name (`bleya`).
- The R2 question is followed by a bucket-name confirmation. A mismatch skips R2.
- Build first: `npm run build`. Then run `node dist/scripts/db.js` directly.

## Local (dev)

- Mongo: `mongodb://localhost:27017/bleya` (from `.env.local`). It isn't a brew service and usually isn't running.
  - Start: `mongod --config /usr/local/etc/mongod.conf --fork`
  - Stop when done: `mongosh --quiet admin --eval 'db.shutdownServer()'` (a "connection closed" error is expected)
- R2 bucket: `bleyachat-images-dev`
- Runner: `node dist/scripts/db.js`
- Answers: `1`, `y`, `N`, `y`, `bleyachat-images-dev`

## Production

- Railway project `bleya`, environment `production`, service `bleya-backend`. The CLI is already linked.
- The backend's `MONGODB_URI` is the public proxy (`turntable.proxy.rlwy.net:40297/bleya`), so `railway run` works from the Mac as-is.
- R2 bucket: `bleyachat-images` (served at images.bleyachat.com)
- Runner: `railway run --service bleya-backend -- node dist/scripts/db.js`
- Answers: `1`, `bleya`, `N`, `y`, `bleyachat-images`
- Counts before and after:
  `railway run --service bleya-backend -- sh -c 'mongosh --quiet "$MONGODB_URI" --eval "db.getCollectionNames().forEach(c=>print(c, db[c].countDocuments()))"'`
- Optional backup (offer it; delete it afterwards if the user says so):
  `railway run --service bleya-backend -- sh -c 'mongodump --uri "$MONGODB_URI" --out "$HOME/bleya-prod-backup-<date>" --quiet'`

## Permissions

Auto mode blocks R2 mass deletes and reading Railway variables unless `.claude/settings.local.json` allows them:
`Bash(node dist/scripts/db.js:*)`, `Bash(npm run db:*)`, `Bash(railway variables:*)`. If a call is denied, stop and tell the user. Never work around the denial.

## Afterwards

- Recount and report what is left (only `cities`, 7,169 entries).
- The `migrations` collection only holds a marker for migration 005. Dropping it with the data is fine.
- Do not seed rooms: city rooms are created on first join (`findOrCreateCityRoom`).
- After a prod wipe, the backend must restart to rebuild the dropped indexes (Mongoose builds them at startup). A push to `master` redeploys it. Otherwise restart `bleya-backend` on Railway.
- Signed-in devices will get auth errors until users sign in again.
- Stop local mongod if you started it.
