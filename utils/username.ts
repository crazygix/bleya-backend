export const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

export function normalizeUsernameInput(username: string): string {
    return username.trim();
}

export function isValidUsername(username: string): boolean {
    return USERNAME_REGEX.test(username);
}
