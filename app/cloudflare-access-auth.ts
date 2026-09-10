import 'server-only';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AccessUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const DEFAULT_TEAM_DOMAIN = 'throbbing-limit-326e.cloudflareaccess.com';
const DEFAULT_AUDIENCE = '04674bc890cc0929ee2939705d16ccbdd4f38e0c66aa7bcf678a4f200e5022be';
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function teamDomain(): string {
  return (process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? DEFAULT_TEAM_DOMAIN)
    .trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function jwksFor(domain: string) {
  const existing = jwksCache.get(domain);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
  jwksCache.set(domain, jwks);
  return jwks;
}

export async function getCloudflareAccessUser(): Promise<AccessUser | null> {
  const { headers } = await import('next/headers');
  const token = (await headers()).get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const domain = teamDomain();
  const issuer = `https://${domain}`;
  try {
    const { payload } = await jwtVerify(token, jwksFor(domain), {
      algorithms: ['RS256'],
      issuer,
      audience: process.env.CLOUDFLARE_ACCESS_AUD?.trim() || DEFAULT_AUDIENCE,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!email || !userId) return null;
    const fullName = typeof payload.name === 'string' ? payload.name : null;
    return { userId, email, fullName, displayName: fullName ?? email };
  } catch {
    return null;
  }
}
