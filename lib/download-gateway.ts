import 'server-only';
import type { Movie } from './movies.ts';
import { listApprovedDomains } from '../db';
import { getRuntimeControls } from './security/runtime-controls';

type GatewaySource = { label: string; quality: string; resolution: string; size: string; url: string };
type GatewayEpisode = { season: number; episode: number; title: string; url?: string; thumbnail?: string; backdrop?: string; description?: string; rating?: number; downloadSources?: GatewaySource[]; downloadStatus?: 'available' | 'pending' };

export async function approvedGatewaySources(movie: Movie, episode?: GatewayEpisode): Promise<{ title: string; poster: string; backdrop?: string; year: number; languages: readonly string[]; episodeLabel?: string; description?: string; rating?: number; sources: GatewaySource[] } | null> {
  const controls = getRuntimeControls();
  const verifiedAt = movie.rightsVerifiedAt ? Date.parse(movie.rightsVerifiedAt) : NaN;
  const expiresAt = movie.rightsExpiresAt ? Date.parse(movie.rightsExpiresAt) : NaN;
  if ((!episode && movie.downloadStatus === 'pending') || (episode && episode.downloadStatus === 'pending') || !controls.externalLinksEnabled || movie.rightsStatus !== 'verified' || !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || !movie.rightsReviewer?.trim() || !movie.rightsReference?.trim()) return null;
  const allowed = new Set((await listApprovedDomains()).filter((item) => item.active).map((item) => item.domain.toLowerCase()));
  const safe = (url: string) => { try { const target = new URL(url); return target.protocol === 'https:' && !target.username && !target.password && !target.port && allowed.has(target.hostname.toLowerCase()); } catch { return false; } };
  const sources = episode ? (episode.downloadSources ?? (episode.url ? [{ label: 'Episode source', quality: 'Standard', resolution: 'Auto', size: 'Unknown', url: episode.url }] : [])).filter((source) => safe(source.url)) : (movie.downloadSources ?? []).filter((source) => safe(source.url));
  return { title: episode?.title || movie.title, poster: episode?.thumbnail || movie.poster, backdrop: episode?.backdrop || movie.backdrop, year: movie.year, languages: movie.languages, description: episode?.description || movie.description, rating: episode?.rating ?? movie.rating, episodeLabel: episode ? `Season ${episode.season} · Episode ${episode.episode}` : undefined, sources };
}
