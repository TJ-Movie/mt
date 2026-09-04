import 'server-only';
import type { Movie } from './movies.ts';
import { listApprovedDomains } from '../db';
import { getRuntimeControls } from './security/runtime-controls';

export async function approvedGatewaySources(movie: Movie, episode?: { season: number; episode: number; title: string; url?: string }): Promise<{ title: string; poster: string; year: number; languages: readonly string[]; episodeLabel?: string; sources: { label: string; quality: string; resolution: string; size: string; url: string }[] } | null> {
  const controls = getRuntimeControls();
  const verifiedAt = movie.rightsVerifiedAt ? Date.parse(movie.rightsVerifiedAt) : NaN;
  const expiresAt = movie.rightsExpiresAt ? Date.parse(movie.rightsExpiresAt) : NaN;
  if (movie.downloadStatus === 'pending' || !controls.externalLinksEnabled || movie.rightsStatus !== 'verified' || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !movie.rightsReviewer?.trim() || !movie.rightsReference?.trim()) return null;
  const allowed = new Set((await listApprovedDomains()).filter((item) => item.active).map((item) => item.domain.toLowerCase()));
  const safe = (url: string) => { try { const target = new URL(url); return target.protocol === 'https:' && !target.username && !target.password && !target.port && allowed.has(target.hostname.toLowerCase()); } catch { return false; } };
  const sources = episode
    ? episode.url && safe(episode.url) ? [{ label: 'Episode source', quality: 'Standard', resolution: 'Auto', size: 'Unknown', url: episode.url }] : []
    : (movie.downloadSources ?? []).filter((source) => safe(source.url));
  return { title: movie.title, poster: movie.poster, year: movie.year, languages: movie.languages, episodeLabel: episode ? `Season ${episode.season} · Episode ${episode.episode} — ${episode.title}` : undefined, sources };
}
