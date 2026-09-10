import 'server-only';
import { logSecurityEvent } from './security-events.ts';

type RateLimitResult = {
  allowed: boolean;
  headers: Record<string, string>;
};

async function clientHash(request: Request, windowStart: number): Promise<string> {
  const address = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const bytes = new TextEncoder().encode(`${windowStart}:${address}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  return (
    origin === new URL(request.url).origin &&
    (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none')
  );
}

export async function enforcePublicRateLimit(
  request: Request,
  scope: 'comments' | 'source-reports' | 'downloads',
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const reset = Math.max(1, windowStart + windowSeconds - nowSeconds);
  const policy = `${limit};w=${windowSeconds}`;

  try {
    const { getDatabase } = await import('../../db/index.ts');
    const database = getDatabase();
    const hash = await clientHash(request, windowStart);
    await database
      .prepare('DELETE FROM public_rate_limits WHERE scope = ? AND window_start < ?')
      .bind(scope, windowStart - windowSeconds * 2)
      .run();
    const row = await database
      .prepare(`INSERT INTO public_rate_limits
        (scope, client_hash, window_start, request_count, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(scope, client_hash, window_start)
        DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
        RETURNING request_count`)
      .bind(scope, hash, windowStart, new Date().toISOString())
      .first<{ request_count: number }>();
    const count = row?.request_count ?? limit + 1;
    const allowed = count <= limit;
    if (!allowed) logSecurityEvent('public_rate_limit_exceeded', 'warn', { scope });
    return {
      allowed,
      headers: {
        'RateLimit-Limit': String(limit),
        'RateLimit-Policy': policy,
        'RateLimit-Remaining': String(Math.max(0, limit - count)),
        'RateLimit-Reset': String(reset),
        ...(allowed ? {} : { 'Retry-After': String(reset) }),
      },
    };
  } catch {
    logSecurityEvent('public_rate_limit_unavailable', 'error', { scope });
    return {
      allowed: process.env.NODE_ENV !== 'production',
      headers: {
        'RateLimit-Limit': String(limit),
        'RateLimit-Policy': policy,
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(reset),
        'Retry-After': String(reset),
      },
    };
  }
}
