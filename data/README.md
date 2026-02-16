# Data Directory

This directory contains seed data and reference files for the Bleya backend.

## Files

### `cities.json`
- **Source**: World Cities Database (https://github.com/dr5hn/countries-states-cities-database)
- **Size**: ~6.5 MB
- **Cities**: 33,258 worldwide
- **Format**: JSON array with city objects containing name, country, lat/lng
- **Usage**: Import cities into MongoDB with `npm run import:cities`
- **Last Updated**: 2026-02-16

## Scripts

To import cities into the database:
```bash
npm run import:cities
```

The import script is idempotent - safe to run multiple times without creating duplicates.
