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

### 2) URL config

Use one key per concept and let the env file decide the environment-specific value:

- `APP_HOST`: local machine/device host used to derive backend URLs
- `PUBLIC_ORIGIN`: optional explicit backend origin, e.g. `http://<LAN_IP_OF_MAC>:8080`
- `API_BASE_URL`: optional explicit API base URL, defaults to `<PUBLIC_ORIGIN>/v1`
- `CLIENT_ORIGIN`: optional primary client origin used for CORS fallback
- `R2_PUBLIC_BASE_URL`: optional public CDN/base URL for uploads

If `CORS_ORIGINS` is empty, the backend now defaults to `CLIENT_ORIGIN`.

Recommended production split:

- website: `https://bleyachat.com`
- api: `https://api.bleyachat.com`
- backend env: `PUBLIC_ORIGIN=https://api.bleyachat.com`
- backend env: `API_BASE_URL=https://api.bleyachat.com/v1`
- backend env: `CLIENT_ORIGIN=https://bleyachat.com`

### 3) Required keys

Set these at minimum in `.env.local`:

- `MONGODB_URI`
- `JWT_SECRET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

### 4) Run locally

```bash
npm run build && npm start
```
