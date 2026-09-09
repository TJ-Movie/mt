import 'server-only';
import { getAdminUser } from './admin-auth';
import type { ChatGPTUser } from '../../app/chatgpt-auth';
export { readBoundedJson } from './request-body';

export const ADMIN_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

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
  return { user };
}
