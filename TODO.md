# TODO - Backend

> **AI INSTRUCTIONS:** This file tracks pending work for the Bleya backend.
> - When the user asks "what's left to do?" or similar, read this file and summarize open items.
> - **Do NOT start, implement, or modify any item below without explicit approval from the user.**
> - When an item is completed, move it to the "Done" section with the date.
> - A matching `TODO.md` exists in the mobile repo. Items marked _(shared)_ appear in both.

---

## Open

### 1. Human-readable errors _(shared)_
Audit all errors returned by the backend that can surface to the end user and ensure they are human-readable.
- Review all API error responses reaching the client
- Replace technical/stacktrace-style messages with user-friendly copy
- Standardize error payload shape (code + user-safe message)
- Ensure internal errors are logged but never leaked to the client

### 2. Legal / policies before go-live _(shared)_
Backend-side requirements to support legal compliance.
- Data handling per Privacy Policy / GDPR (retention, export, deletion)
- Account deletion endpoint (required by Apple App Store and Google Play)
- Data export endpoint (GDPR right to access)
- Audit what PII is stored and where
- Terms acceptance tracking (if required)

---

## Done

_(empty)_
