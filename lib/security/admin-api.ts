import 'server-only';
import { getAdminUser } from './admin-auth';
import { getDatabase } from '../../db';
import { logSecurityEvent } from './security-events';
import type { ChatGPTUser } from '../../app/chatgpt-auth';
export { readBoundedJson } from './request-body';

export const ADMIN_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

async function enforceAdminWriteRateLimit(request: Request, userId: string): Promise<Response | null> {
  const windowSeconds = 60;
  const limit = 30;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const address = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${windowStart}:${address}:${userId}`));
  const clientHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    await getDatabase().prepare('DELETE FROM public_rate_limits WHERE scope = ? AND window_start < ?').bind('admin-writes', windowStart - windowSeconds * 2).run();
    const row = await getDatabase().prepare(`INSERT INTO public_rate_limits
      (scope, client_hash, window_start, request_count, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(scope, client_hash, window_start) DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
      RETURNING request_count`).bind('admin-writes', clientHash, windowStart, new Date().toISOString()).first<{ request_count: number }>();
    const count = row?.request_count ?? limit + 1;
    if (count <= limit) return null;
    const reset = Math.max(1, windowStart + windowSeconds - now);
    logSecurityEvent('admin_rate_limit_exceeded', 'warn', { scope: 'admin-writes' });
    return Response.json({ error: 'Too many admin write requests. Try again shortly.' }, { status: 429, headers: { ...ADMIN_NO_STORE_HEADERS, 'Retry-After': String(reset), 'RateLimit-Limit': String(limit), 'RateLimit-Remaining': '0', 'RateLimit-Reset': String(reset) } });
  } catch {
    logSecurityEvent('admin_rate_limit_unavailable', 'error', { scope: 'admin-writes' });
    return process.env.NODE_ENV === 'production'
      ? Response.json({ error: 'Admin write protection is temporarily unavailable.' }, { status: 503, headers: ADMIN_NO_STORE_HEADERS })
      : null;
  }
}

export async function authorizeAdminRequest(request: Request, write = false): Promise<{ user: ChatGPTUser } | { response: Response }> {
  const user = await getAdminUser();
  if (!user) return { response: Response.json({ error: 'Not found.' }, { status: 404, headers: ADMIN_NO_STORE_HEADERS }) };
  if (!write) return { user };

  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (
    origin !== new URL(request.url).origin ||
    (fetchSite !== null && fetchSite !== 'same-origin') ||
    request.headers.get('x-sublyra-action') !== 'admin-write'
  ) return { response: Response.json({ error: 'Request rejected.' }, { status: 403, headers: ADMIN_NO_STORE_HEADERS }) };
  const limited = await enforceAdminWriteRateLimit(request, user.userId);
  if (limited) return { response: limited };
  return { user };
}
