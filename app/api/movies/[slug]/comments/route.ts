import { getDatabase, getPublishedMovie } from '../../../../../db';
import { readBoundedJson } from '../../../../../lib/security/request-body';
import { enforcePublicRateLimit, isSameOriginRequest } from '../../../../../lib/security/public-rate-limit';
import { logSecurityEvent } from '../../../../../lib/security/security-events';

const MAX_NAME = 40;
const MAX_BODY = 500;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  let normalized = '';
  for (const character of value.normalize('NFKC')) {
      const code = character.codePointAt(0) ?? 0;
      normalized += code <= 31 || code === 127 ? ' ' : character;
  }
  normalized = normalized.trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = clean((await params).slug, 80);
  if (!slug) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: HEADERS });
  const rateLimit = await enforcePublicRateLimit(request, 'comments', 60, 60);
  if (!rateLimit.allowed) return Response.json({ error: 'Too many requests. Try again later.' }, { status: 429, headers: { ...HEADERS, ...rateLimit.headers } });
  try {
    const database = getDatabase();
    const movie = await database.prepare("SELECT id FROM movies WHERE slug = ? AND publication_status = 'published' LIMIT 1").bind(slug).first<{ id: number }>();
    if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: { ...HEADERS, ...rateLimit.headers } });
    const rows = await database.prepare(`SELECT id, display_name, body, created_at FROM movie_comments WHERE movie_slug = ? AND status = 'visible' ORDER BY id DESC LIMIT 50`).bind(slug).all<{ id: number; display_name: string; body: string; created_at: string }>();
    return Response.json({ comments: rows.results.map((row) => ({ id: row.id, name: row.display_name, body: row.body, createdAt: row.created_at })) }, { headers: { ...HEADERS, ...rateLimit.headers } });
  } catch {
    return Response.json({ comments: [] }, { headers: { ...HEADERS, ...rateLimit.headers } });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = clean((await params).slug, 80);
  if (!slug) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: HEADERS });
  if (!isSameOriginRequest(request)) {
    logSecurityEvent('public_request_rejected', 'warn', { scope: 'comments', reason: 'cross_origin' });
    return Response.json({ error: 'Request rejected.' }, { status: 403, headers: HEADERS });
  }
  const rateLimit = await enforcePublicRateLimit(request, 'comments', 5, 600);
  if (!rateLimit.allowed) {
    return Response.json({ error: 'Too many comments. Try again later.' }, { status: 429, headers: { ...HEADERS, ...rateLimit.headers } });
  }
  const movie = await getPublishedMovie(slug);
  if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: HEADERS });
  const rawInput = await readBoundedJson(request, 2_048);
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput as { name?: unknown; body?: unknown; website?: unknown }
    : null;
  if (input?.website) return Response.json({ ok: true }, { headers: HEADERS });
  const name = clean(input?.name, MAX_NAME);
  const body = clean(input?.body, MAX_BODY);
  if (!name || !body) return Response.json({ error: `Name and comment are required (max ${MAX_NAME}/${MAX_BODY} characters).` }, { status: 400, headers: HEADERS });
  try {
    await getDatabase().prepare(`INSERT INTO movie_comments (movie_slug, display_name, body, status, created_at) VALUES (?, ?, ?, 'visible', ?)`).bind(slug, name, body, new Date().toISOString()).run();
    return Response.json({ ok: true }, { status: 201, headers: HEADERS });
  } catch {
    return Response.json({ error: 'Comments are temporarily unavailable.' }, { status: 503, headers: HEADERS });
  }
}
