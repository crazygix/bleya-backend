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
- `GOOGLE_ALLOWED_AUDIENCES`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_BASE_URL`

### 4) Optional keys

- `IMAGE_SERVICE_PROVIDER`: `pexels` or `wikidata`
- `PEXELS_API_KEY`: used when `IMAGE_SERVICE_PROVIDER=pexels`; falls back to Wikidata if missing
- `APPLE_ALLOWED_AUDIENCES`: comma-separated Apple token audiences; include the iOS bundle ID and, if Android Sign in with Apple is enabled, the Android Service ID
- `APPLE_ANDROID_SERVICE_ID`: Apple Service ID used for the Android web flow; it must also appear in `APPLE_ALLOWED_AUDIENCES`
- `APPLE_ANDROID_REDIRECT_PATH`: absolute backend callback path for the Android Apple flow; must stay under `/v1/auth/` so production resolves to `https://api.bleyachat.com${APPLE_ANDROID_REDIRECT_PATH}`
- `ANDROID_PACKAGE_NAME`
- `PASSKEY_RP_ID`
- `PASSKEY_RP_NAME`
- `PASSKEY_EXPECTED_ORIGINS`: comma-separated exact origins, no quotes or trailing slash: `https://<PASSKEY_RP_ID>` for iOS plus `android:apk-key-hash:<hash>` for each certificate the Android app is signed with (in production the Play app signing key and the upload key). `<hash>` is the certificate's SHA-256 in base64url without padding:
  `FP='AA:BB:…'; echo "android:apk-key-hash:$(echo "$FP" | tr -d ':' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '=')"`
  Empty means `https://<PASSKEY_RP_ID>` only. Production startup logs `config.passkey_origins` when the list looks wrong.
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
  Push notifications stay disabled in development when these are missing.
  Production startup validation requires all three Firebase values.
- `HTTP_LOG_BODY_MODE`: `off`, `errors`, or `all`
- `HTTP_LOG_BODY_REDACT`
- `HTTP_LOG_BODY_TRUNCATE`
- `HTTP_LOG_BODY_MAX_BYTES`

### 5) Run locally

```bash
npm run build && npm start
```
