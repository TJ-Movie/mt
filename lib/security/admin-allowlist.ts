const MAX_ADMIN_IDS = 10;

export function isAdminUserId(userId: string, configured = process.env.SUBLYRA_ADMIN_USER_IDS): boolean {
  if (process.env.NODE_ENV !== 'production' && userId === 'local_seedy') return true;
  if (!configured) return false;
  const allowed = configured.split(',').map((value) => value.trim()).filter(Boolean).slice(0, MAX_ADMIN_IDS);
  return allowed.includes(userId);
}

export function isAdminEmail(email: string, configured = process.env.SUBLYRA_ADMIN_EMAILS): boolean {
  if (!configured) return false;
  const normalized = email.trim().toLowerCase();
  return configured.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean).slice(0, MAX_ADMIN_IDS).includes(normalized);
}
