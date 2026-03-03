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

### 2) Required keys

Set these at minimum in `.env.local`:

- `MONGODB_URI`
- `JWT_SECRET`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

### 3) Run locally

```bash
npm run build && npm start
```
