export type SecurityEventName =
  | 'catalogue_request_rejected'
  | 'catalogue_database_unavailable'
  | 'admin_request_rejected'
  | 'admin_movie_changed'
  | 'admin_asset_uploaded'
  | 'outbound_redirect_allowed'
  | 'outbound_redirect_denied';

type SecurityLevel = 'info' | 'warn' | 'error';
type SecurityValue = string | number | boolean | null | undefined;

const MAX_FIELD_LENGTH = 120;

function safeValue(value: SecurityValue): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  return value.replace(/[\r\n\t]/g, ' ').slice(0, MAX_FIELD_LENGTH);
}

/** Emits allowlisted, single-line JSON without URLs, credentials, or request bodies. */
export function logSecurityEvent(
  event: SecurityEventName,
  level: SecurityLevel,
  fields: Readonly<Record<string, SecurityValue>> = {},
): void {
  const sanitizedFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, safeValue(value)]),
  );
  const message = JSON.stringify({
    timestamp: new Date().toISOString(),
    category: 'security',
    event,
    ...sanitizedFields,
  });

  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.info(message);
}
