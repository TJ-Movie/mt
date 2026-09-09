import 'server-only';
import { getCloudflareAccessUser, type AccessUser } from '../../app/cloudflare-access-auth';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAdminEmail, isAdminUserId } from './admin-allowlist';

export { isAdminEmail, isAdminUserId } from './admin-allowlist';

// Studio access is delegated to Cloudflare Access; no ChatGPT OAuth is used.

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
    // Send unauthenticated users directly to the Access team login host. The
    // custom hostname's /cdn-cgi/access/login path is not served by Sites and
    // otherwise returns a Cloudflare 404 before Access can start the flow.
    const requestHeaders = await headers();
    const forwardedHost = requestHeaders.get('x-forwarded-host') ?? requestHeaders.get('host') ?? 'flixlyra.com';
    // Sites may expose its internal *.chatgpt.site host in forwarded headers
    // even when the visitor used the custom domain. Keep the Access callback
    // on the public Flixlyra hostname so the authorization cookie is scoped
    // correctly.
    const host = forwardedHost.endsWith('.chatgpt.site') ? 'flixlyra.com' : forwardedHost;
    const protocol = requestHeaders.get('x-forwarded-proto') ?? 'https';
    const returnUrl = `${protocol}://${host}${_returnTo.startsWith('/') ? _returnTo : `/${_returnTo}`}`;
    const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? 'throbbing-limit-326e.cloudflareaccess.com';
    redirect(`https://${teamDomain}/cdn-cgi/access/login/${host}?redirect_url=${encodeURIComponent(returnUrl)}`);
  }
  if (!isAdminUser(user)) notFound();
  return user;
}
