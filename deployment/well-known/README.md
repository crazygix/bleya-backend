# Well-Known Deployment Files

These files must be hosted on `https://bleyachat.com/.well-known/`, not on the
API host.

Files:

- `apple-app-site-association`
- `assetlinks.json`

Current values baked into these files:

- Apple Team ID: `S7V679NZ3B`
- iOS bundle ID: `com.bleyachat`
- Android package: `com.bleyachat`
- Android debug SHA-256:
  `C6:40:AF:66:CD:1B:37:D2:B1:7C:FD:EE:FA:97:9E:84:8A:21:5E:D6:CB:79:1D:DF:2A:26:77:32:DF:99:AE:36`
- Android release SHA-256:
  `7E:B2:01:C0:48:9E:95:46:78:D1:B6:FE:38:BB:17:4C:40:DF:F1:56:47:7A:5B:37:90:21:FD:FE:88:D2:52:D3`

Backend passkey origins derived from those fingerprints:

- `https://bleyachat.com`
- `android:apk-key-hash:xkCvZs0bN9KxfP3u-peehIohXtbLeR3fKiZ3Mt-ZrjY`
- `android:apk-key-hash:frIBwEielUZ40bb-OLsXTEDf8VZHels3kCH9_ojSUtM`

Before production release, add your Google Play App Signing SHA-256 to
`assetlinks.json` and to `PASSKEY_EXPECTED_ORIGINS` if Play signs the final APK
with a different certificate than the local release keystore.
