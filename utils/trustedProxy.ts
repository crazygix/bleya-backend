import net from 'net';
import type { Request } from 'express';

// Production traffic reaches the app as client -> Cloudflare -> Railway edge ->
// app. Express must skip both proxy hops to find the real client IP; otherwise
// every per-IP rate limit keys on a shared Cloudflare edge address.
//
// Cloudflare's published ranges (https://www.cloudflare.com/ips/, checked
// 2026-09-28). They change rarely; TRUSTED_PROXY_CIDRS can add more without a
// deploy.
const CLOUDFLARE_CIDRS = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
];

function parseExtraCidrs(): string[] {
    return (process.env.TRUSTED_PROXY_CIDRS || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function buildBlockList(cidrs: string[]): net.BlockList {
    const list = new net.BlockList();
    for (const cidr of cidrs) {
        const [address, prefix] = cidr.split('/');
        const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
        if (!net.isIP(address) || !prefix) {
            continue;
        }
        list.addSubnet(address, Number(prefix), family);
    }
    return list;
}

const trustedProxyRanges = buildBlockList([...CLOUDFLARE_CIDRS, ...parseExtraCidrs()]);

function normalizeAddress(address: string): string {
    // IPv4 clients show up as IPv4-mapped IPv6 on dual-stack sockets.
    return address.startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address;
}

export function isTrustedProxyAddress(address: string | undefined): boolean {
    if (!address) {
        return false;
    }

    const normalized = normalizeAddress(address.trim());
    const family = net.isIP(normalized);
    if (family === 0) {
        return false;
    }

    return trustedProxyRanges.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Express `trust proxy` callback. Hop 0 is the socket peer — always Railway's
 * edge proxy in production — so it is trusted; any further hop is trusted only
 * when it is a known Cloudflare address. The first untrusted hop is the client,
 * so client-supplied X-Forwarded-For entries to the left of it are ignored.
 */
export function trustProxy(address: string, hopIndex: number): boolean {
    return hopIndex === 0 || isTrustedProxyAddress(address);
}

/**
 * Best-effort real client IP. Normally `req.ip` (resolved via trustProxy). If a
 * proxy in front of us overwrote X-Forwarded-For so that `req.ip` is still a
 * Cloudflare edge address, fall back to Cloudflare's own CF-Connecting-IP —
 * trusted only in that case, so it can't be spoofed by connecting directly.
 */
export function getClientIp(req: Request): string {
    const resolved = req.ip || req.socket?.remoteAddress || '';
    if (!isTrustedProxyAddress(resolved)) {
        return resolved;
    }

    const cfConnectingIp = req.headers['cf-connecting-ip'];
    const candidate = Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp;
    if (typeof candidate === 'string' && net.isIP(candidate.trim()) !== 0) {
        return candidate.trim();
    }

    return resolved;
}
