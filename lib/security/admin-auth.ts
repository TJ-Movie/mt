import 'server-only';
import { getChatGPTUser, requireChatGPTUser, type ChatGPTUser } from '../../app/chatgpt-auth';
import { notFound } from 'next/navigation';
import { isAdminUserId } from './admin-allowlist';

export { isAdminUserId } from './admin-allowlist';

export async function getAdminUser(): Promise<ChatGPTUser | null> {
  const user = await getChatGPTUser();
  return user && isAdminUserId(user.userId) ? user : null;
}

export async function requireAdminUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await requireChatGPTUser(returnTo);
  if (!isAdminUserId(user.userId)) notFound();
  return user;
}
