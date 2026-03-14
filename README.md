## Backend Configuration

### 1) Create local env file

```bash
cp .env.example .env.local
```

`config/index.ts` loads env files in this order (later overrides earlier):

1. `.env`
2. `.env.<NODE_ENV>`
3. `.env.local`
4. `.env.<NODE_ENV>.local`

Recommended local setup:

- Keep machine-specific values in `.env.local`
- Never commit `.env.local` (ignored by git)
- Keep `.env.example` updated whenever a new env key is added

### 2) Fixed app URLs

The backend no longer reads URL and CORS settings from env.

- Production API origin is fixed to `https://api.bleyachat.com`
- Production browser origins are fixed to `https://bleyachat.com` and `https://www.bleyachat.com`
- Development allows all origins
- `R2_PUBLIC_BASE_URL` still controls the public image base URL

### 3) Required keys

Set these at minimum in `.env.local`:

- `MONGODB_URI`
- `JWT_SECRET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

### 4) Optional keys

- `IMAGE_SERVICE_PROVIDER`: `pexels` or `wikidata`
- `PEXELS_API_KEY`: used when `IMAGE_SERVICE_PROVIDER=pexels`; falls back to Wikidata if missing
- `HTTP_LOG_BODY_MODE`: `off`, `errors`, or `all`
- `HTTP_LOG_BODY_REDACT`
- `HTTP_LOG_BODY_TRUNCATE`
- `HTTP_LOG_BODY_MAX_BYTES`

### 5) Run locally

```bash
npm run build && npm start
```
