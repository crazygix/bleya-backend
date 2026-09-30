export const DAY_MS = 24 * 60 * 60 * 1000;

// The time a record created at [from] is deleted, [days] later (records carry
// it in retainUntil, which a TTL index acts on).
export function retainUntilAfter(days: number, from: Date = new Date()): Date {
    return new Date(from.getTime() + days * DAY_MS);
}
