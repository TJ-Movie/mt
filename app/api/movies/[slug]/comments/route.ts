import { getDatabase, getPublishedMovie } from '../../../../../db';

const MAX_NAME = 40;
const MAX_BODY = 500;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = clean((await params).slug, 80);
  if (!slug) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: HEADERS });
  const movie = await getPublishedMovie(slug);
  if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: HEADERS });
  try {
    const rows = await getDatabase().prepare(`SELECT id, display_name, body, created_at FROM movie_comments WHERE movie_slug = ? AND status = 'visible' ORDER BY id DESC LIMIT 50`).bind(slug).all<{ id: number; display_name: string; body: string; created_at: string }>();
    return Response.json({ comments: rows.results.map((row) => ({ id: row.id, name: row.display_name, body: row.body, createdAt: row.created_at })) }, { headers: HEADERS });
  } catch {
    return Response.json({ comments: [] }, { headers: HEADERS });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const slug = clean((await params).slug, 80);
  if (!slug) return Response.json({ error: 'Invalid movie.' }, { status: 400, headers: HEADERS });
  const movie = await getPublishedMovie(slug);
  if (!movie) return Response.json({ error: 'Movie not found.' }, { status: 404, headers: HEADERS });
  const input = await request.json().catch(() => null) as { name?: unknown; body?: unknown; website?: unknown } | null;
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
