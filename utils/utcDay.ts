import { DAY_MS } from './retention.js';

// Analytics count by UTC calendar day; a day is identified by its midnight UTC.

export function startOfUtcDay(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(day: Date, days: number): Date {
    return new Date(day.getTime() + days * DAY_MS);
}
