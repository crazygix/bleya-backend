// Shared, dependency-free helper that decides whether a user is currently
// blocked from acting (connecting a socket, sending messages) based on their
// moderation status. Used by the socket handshake and the message-send service
// so the rule lives in exactly one place.

export type UserStatus = 'active' | 'suspended' | 'banned';

export interface EnforcementState {
    status?: string | null;
    suspendedUntil?: Date | null;
    enforcementReason?: string | null;
}

export interface EnforcementDecision {
    blocked: boolean;
    reason: string;
}

export function isUserBlockedFromActing(state: EnforcementState, now: Date = new Date()): EnforcementDecision {
    if (state.status === 'banned') {
        return { blocked: true, reason: state.enforcementReason || 'Your account has been banned.' };
    }

    if (state.status === 'suspended') {
        // No end date => indefinite suspension. A future date => still suspended.
        // A past date => the suspension has lapsed; treat as active.
        if (!state.suspendedUntil || state.suspendedUntil.getTime() > now.getTime()) {
            return { blocked: true, reason: state.enforcementReason || 'Your account is suspended.' };
        }
    }

    return { blocked: false, reason: '' };
}

/**
 * User-facing explanation for a blocked account, shown by the app when sign-in
 * or token refresh is refused. Null when the account may act.
 */
export function describeEnforcementForUser(state: EnforcementState, now: Date = new Date()): string | null {
    if (!isUserBlockedFromActing(state, now).blocked) {
        return null;
    }

    const moderatorReason = state.enforcementReason?.trim();
    const reasonSuffix = moderatorReason ? ` Reason: ${moderatorReason}` : '';

    if (state.status === 'banned') {
        return `Your account has been banned.${reasonSuffix}`;
    }

    const until = state.suspendedUntil
        ? ` until ${state.suspendedUntil.toISOString().slice(0, 10)}`
        : '';
    return `Your account is suspended${until}.${reasonSuffix}`;
}
