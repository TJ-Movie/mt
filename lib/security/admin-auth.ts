import 'server-only';
import { getCloudflareAccessUser, type AccessUser } from '../../app/cloudflare-access-auth';
import { notFound } from 'next/navigation';
import { isAdminEmail, isAdminUserId } from './admin-allowlist';

export { isAdminEmail, isAdminUserId } from './admin-allowlist';

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
  if (!user || !isAdminUser(user)) notFound();
  return user;
}
