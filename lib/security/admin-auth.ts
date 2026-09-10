import 'server-only';
import { getCloudflareAccessUser, type AccessUser } from '../../app/cloudflare-access-auth';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAdminEmail, isAdminUserId } from './admin-allowlist';

export { isAdminEmail, isAdminUserId } from './admin-allowlist';

// Studio access is delegated to Cloudflare Access; no ChatGPT OAuth is used.
const DEFAULT_ACCESS_AUDIENCE = '04674bc890cc0929ee2939705d16ccbdd4f38e0c66aa7bcf678a4f200e5022be';

function isAdminUser(user: AccessUser): boolean {
  const configuredIds = process.env.SUBLYRA_ADMIN_USER_IDS;
  return configuredIds?.trim()
    ? isAdminUserId(user.userId, configuredIds)
    : isAdminEmail(user.email);
}

export async function getAdminUser(): Promise<AccessUser | null> {
  const user = await getCloudflareAccessUser();
  return user && isAdminUser(user) ? user : null;
}

export async function requireAdminUser(_returnTo: string): Promise<AccessUser> {
  const user = await getCloudflareAccessUser();
  if (!user) {
    const requestHeaders = await headers();
    // A rejected assertion must fail closed, not start another login loop.
    if (requestHeaders.has('Cf-Access-Jwt-Assertion')) notFound();
    // Access protects this canonical hostname, including visits via workers.dev.
    const host = 'flixlyra.com';
    const path = _returnTo.startsWith('/') && !_returnTo.startsWith('//') ? _returnTo : '/studio';
    const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? 'throbbing-limit-326e.cloudflareaccess.com';
    const audience = process.env.CLOUDFLARE_ACCESS_AUD?.trim() || DEFAULT_ACCESS_AUDIENCE;
    const params = new URLSearchParams({ kid: audience, redirect_url: path });
    redirect(`https://${teamDomain}/cdn-cgi/access/login/${host}?${params.toString()}`);
  }
  if (!isAdminUser(user)) notFound();
  return user;
}
