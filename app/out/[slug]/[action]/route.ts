import { getMovie } from '../../../../lib/movies';

const ALLOWED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be', 't.me', 'telegram.me']);

export async function GET(request: Request, context: { params: Promise<{ slug: string; action: string }> }) {
  const { slug, action } = await context.params;
  const movie = getMovie(slug);
  if (!movie || !['watch', 'telegram'].includes(action)) return new Response('Not found', { status: 404 });
  const destination = action === 'watch' ? movie.officialWatchUrl : movie.telegramUrl;
  if (!destination) return new Response('This verified link is not available yet.', { status: 404 });
  let target: URL;
  try { target = new URL(destination); } catch { return new Response('Invalid destination', { status: 400 }); }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) return new Response('Blocked destination', { status: 400 });
  return Response.redirect(target, 302);
}
