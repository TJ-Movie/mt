import 'server-only';
import { getChatGPTUser, requireChatGPTUser, type ChatGPTUser } from '../../app/chatgpt-auth';
import { notFound } from 'next/navigation';
import { isAdminEmail, isAdminUserId } from './admin-allowlist';

export { isAdminEmail, isAdminUserId } from './admin-allowlist';

function isAdminUser(user: ChatGPTUser): boolean {
  return isAdminUserId(user.userId) || isAdminEmail(user.email);
}

export async function getAdminUser(): Promise<ChatGPTUser | null> {
  const user = await getChatGPTUser();
  return user && isAdminUser(user) ? user : null;
}

export async function requireAdminUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await requireChatGPTUser(returnTo);
  if (!isAdminUser(user)) notFound();
  return user;
}
