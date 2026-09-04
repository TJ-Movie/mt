import { allLanguages, contentTypes, genres } from '../catalogue-options.ts';
import { publicationStatuses, rightsStatuses, type PublicationStatus, type RightsStatus } from '../movies.ts';
import { validateOutboundDestination } from '../security/outbound-links.ts';

export type AdminMovieInput = {
  streamingSources: { label: string; url: string }[];
  episodes: { season: number; episode: number; title: string; url?: string; thumbnail?: string; backdrop?: string; description?: string; rating?: number; streamingSources?: { label: string; url: string }[]; downloadSources?: { label: string; quality: string; resolution: string; size: string; url: string }[]; downloadStatus?: 'available' | 'pending' }[];
  downloadStatus: 'available' | 'pending';
  downloadSources: { label: string; quality: string; resolution: string; size: string; url: string }[];
  contentType: 'movie' | 'series';
  slug: string;
  title: string;
  tagline: string;
  description: string;
  year: number;
  runtime: string;
  rating: number;
  genre: string;
  director: string;
  cast: (string | { actor: string; character?: string; image?: string })[];
  languages: string[];
  poster: string;
  backdrop: string;
  featured: boolean;
  publicationStatus: PublicationStatus;
  rightsStatus: RightsStatus;
  rightsVerifiedAt: string | null;
  rightsExpiresAt: string | null;
  rightsReviewer: string | null;
  rightsReference: string | null;
  officialWatchUrl: string | null;
  telegramUrl: string | null;
  telegramChannel: string | null;
  subtitleUrl: string | null;
};

export type ValidationResult =
  | { ok: true; value: AdminMovieInput }
  | { ok: false; errors: Record<string, string> };

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCAL_ASSET = /^\/(?:og\.png|media\/movie-art\/[a-f0-9-]{36}\.(?:jpg|png))$/;

type RightsControlledFields = Pick<AdminMovieInput,
  'rightsStatus' | 'rightsExpiresAt' | 'rightsReference' | 'officialWatchUrl' | 'telegramUrl' | 'telegramChannel'>;

export function requiresRightsReset(current: RightsControlledFields, next: RightsControlledFields): boolean {
  if (current.rightsStatus !== 'verified' || next.rightsStatus !== 'verified') return false;
  return current.rightsExpiresAt !== next.rightsExpiresAt ||
    current.rightsReference !== next.rightsReference ||
    current.officialWatchUrl !== next.officialWatchUrl ||
    current.telegramUrl !== next.telegramUrl ||
    current.telegramChannel !== next.telegramChannel;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function sourceUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.normalize('NFKC').trim();
  const markdown = /^\[https:\/\/[^\]]+\]\((https:\/\/[^)]+)\)$/i.exec(trimmed);
  return (markdown?.[1] ?? trimmed).slice(0, 500);
}

function textField(source: Record<string, unknown>, key: string, minimum: number, maximum: number, errors: Record<string, string>): string {
  const raw = source[key];
  if (typeof raw !== 'string') { errors[key] = 'Required text field.'; return ''; }
  const value = raw.normalize('NFKC').trim();
  if (value.length < minimum || value.length > maximum || hasControlCharacter(value)) errors[key] = `Use ${minimum}-${maximum} safe characters.`;
  return value;
}

function optionalText(source: Record<string, unknown>, key: string, maximum: number, errors: Record<string, string>): string | null {
  const raw = source[key];
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') { errors[key] = 'Invalid text field.'; return null; }
  const value = raw.normalize('NFKC').trim();
  if (!value || value.length > maximum || hasControlCharacter(value)) errors[key] = `Use at most ${maximum} safe characters.`;
  return value || null;
}

function listField(source: Record<string, unknown>, key: string, allowed: readonly string[] | null, errors: Record<string, string>, required = true): string[] {
  const raw = source[key];
  if (raw === undefined || raw === null || raw === '') return required ? (errors[key] = 'Select at least one value.', []) : [];
  if (!Array.isArray(raw) || raw.length < (required ? 1 : 0) || raw.length > 20) { errors[key] = required ? 'Select between 1 and 20 values.' : 'Select no more than 20 values.'; return []; }
  const values = raw.map((item) => typeof item === 'string' ? item.normalize('NFKC').trim() : '');
  if (values.some((item) => !item || item.length > 100 || hasControlCharacter(item))) errors[key] = 'Contains an invalid value.';
  if (allowed && values.some((item) => !allowed.includes(item))) errors[key] = 'Contains an unsupported value.';
  return [...new Set(values)];
}

function isoDate(value: string | null, key: string, errors: Record<string, string>): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) { errors[key] = 'Use a valid date and time.'; return null; }
  return new Date(timestamp).toISOString();
}

export function validateAdminMovieInput(input: unknown, now = Date.now()): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: { form: 'Invalid movie record.' } };
  const source = input as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const slug = textField(source, 'slug', 2, 80, errors).toLowerCase();
  if (!SLUG.test(slug)) errors.slug = 'Use lowercase letters, numbers, and single hyphens.';
  const title = textField(source, 'title', 1, 160, errors);
  const tagline = textField(source, 'tagline', 0, 200, errors);
  const description = textField(source, 'description', 0, 2_000, errors);
  const runtime = textField(source, 'runtime', 0, 30, errors);
  const contentType = source.contentType ?? 'movie';
  const downloadStatus = source.downloadStatus === 'pending' ? 'pending' : 'available';
  if (typeof contentType !== 'string' || !contentTypes.includes(contentType as 'movie' | 'series')) errors.contentType = 'Select Movie or TV Series.';
  const genre = textField(source, 'genre', 2, 200, errors);
  const director = textField(source, 'director', 0, 160, errors);
  const selectedGenres = genre.split(',').map((item) => item.trim()).filter(Boolean);
  if (!selectedGenres.length || selectedGenres.length > 8 || selectedGenres.some((item) => item === 'All' || !genres.includes(item))) errors.genre = 'Select one or more supported genres.';

  const year = source.year;
  const rating = source.rating;
  const maximumYear = new Date(now).getUTCFullYear() + 5;
  if (!Number.isInteger(year) || Number(year) < 1888 || Number(year) > maximumYear) errors.year = `Use a year from 1888 to ${maximumYear}.`;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) errors.rating = 'Use a rating from 0 to 10.';

  const rawCast = Array.isArray(source.cast) ? source.cast.slice(0, 100) : [];
  const cast = rawCast.map((member) => typeof member === 'string' ? member.normalize('NFKC').trim().slice(0, 120) : member && typeof member === 'object' && typeof member.actor === 'string' ? { actor: member.actor.normalize('NFKC').trim().slice(0, 120), character: typeof member.character === 'string' ? member.character.normalize('NFKC').trim().slice(0, 120) : undefined, image: typeof member.image === 'string' ? member.image.trim().slice(0, 500) : undefined } : '').filter((member) => typeof member === 'string' ? member.length > 0 : member.actor.length > 0);
  const languages = listField(source, 'languages', allLanguages, errors);
  const poster = textField(source, 'poster', 1, 200, errors);
  const backdrop = textField(source, 'backdrop', 1, 200, errors);
  if (!LOCAL_ASSET.test(poster)) errors.poster = 'Upload a local JPG/PNG image or use /og.png.';
  if (!LOCAL_ASSET.test(backdrop)) errors.backdrop = 'Upload a local JPG/PNG image or use /og.png.';

  const publicationStatus = source.publicationStatus;
  const rightsStatus = source.rightsStatus;
  if (typeof publicationStatus !== 'string' || !publicationStatuses.includes(publicationStatus as PublicationStatus)) errors.publicationStatus = 'Invalid publication status.';
  if (typeof rightsStatus !== 'string' || !rightsStatuses.includes(rightsStatus as RightsStatus)) errors.rightsStatus = 'Invalid rights status.';
  if (typeof source.featured !== 'boolean') errors.featured = 'Invalid featured value.';

  const rightsVerifiedAt = isoDate(optionalText(source, 'rightsVerifiedAt', 40, errors), 'rightsVerifiedAt', errors);
  const rightsExpiresAt = isoDate(optionalText(source, 'rightsExpiresAt', 40, errors), 'rightsExpiresAt', errors);
  const rightsReviewer = optionalText(source, 'rightsReviewer', 120, errors);
  const rightsReference = optionalText(source, 'rightsReference', 160, errors);
  const officialWatchUrl = optionalText(source, 'officialWatchUrl', 500, errors);
  const telegramUrl = optionalText(source, 'telegramUrl', 500, errors);
  const telegramChannel = optionalText(source, 'telegramChannel', 32, errors);
  const subtitleUrl = optionalText(source, 'subtitleUrl', 240, errors);
  const rawStreaming = source.streamingSources;
  const streamingSources = Array.isArray(rawStreaming) ? rawStreaming.slice(0, 8).map((item) => ({ label: typeof item?.label === 'string' ? item.label.normalize('NFKC').trim().slice(0, 40) : '', url: sourceUrl(item?.url) })).filter((item) => item.label && /^https:\/\/[^\s]+$/i.test(item.url)) : [];
  const rawSources = source.downloadSources;
  const downloadSources = Array.isArray(rawSources) ? rawSources.slice(0, 12).map((item, index) => { const url=typeof item?.url==='string'?item.url.normalize('NFKC').trim().slice(0,500):''; return { label: typeof item?.label==='string'&&item.label.trim()?item.label.normalize('NFKC').trim().slice(0,40):`Download ${index+1}`, quality: typeof item?.quality==='string'&&item.quality.trim()?item.quality.normalize('NFKC').trim().slice(0,24):'Standard', resolution: typeof item?.resolution==='string'&&item.resolution.trim()?item.resolution.normalize('NFKC').trim().slice(0,24):'Auto', size: typeof item?.size==='string'&&item.size.trim()?item.size.normalize('NFKC').trim().slice(0,24):'Unknown', url }; }).filter((item) => /^https:\/\/[^\s]+$/i.test(item.url)) : [];
  const rawEpisodes = source.episodes;
  const episodes = Array.isArray(rawEpisodes) ? rawEpisodes.slice(0, 500).filter((item) => item && Number.isInteger(item.season) && item.season > 0 && Number.isInteger(item.episode) && item.episode > 0 && typeof item.title === 'string').map((item) => ({ season: item.season, episode: item.episode, title: item.title.normalize('NFKC').trim().slice(0, 160), url: typeof item.url === 'string' && /^https:\/\/[^\s]+$/i.test(item.url.trim()) ? item.url.trim().slice(0, 500) : undefined, thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail.trim().slice(0, 500) : undefined, backdrop: typeof item.backdrop === 'string' ? item.backdrop.trim().slice(0, 500) : undefined, description: typeof item.description === 'string' ? item.description.normalize('NFKC').trim().slice(0, 1000) : undefined, rating: Number.isFinite(item.rating) ? Math.max(0, Math.min(10, Number(item.rating))) : undefined, downloadStatus: item.downloadStatus === 'pending' ? 'pending' : 'available', downloadSources: Array.isArray(item.downloadSources) ? item.downloadSources.slice(0, 20).filter((source) => source && typeof source.url === 'string' && /^https:\/\/[^\s]+$/i.test(source.url.trim())).map((source) => ({ label: typeof source.label === 'string' ? source.label.trim().slice(0, 80) : 'Download', quality: typeof source.quality === 'string' ? source.quality.trim().slice(0, 40) : 'Standard', resolution: typeof source.resolution === 'string' ? source.resolution.trim().slice(0, 20) : 'Auto', size: typeof source.size === 'string' ? source.size.trim().slice(0, 40) : 'Unknown', url: source.url.trim().slice(0, 1000) })) : undefined })) : [];
  if (Array.isArray(rawSources) && rawSources.length > 12) errors.downloadSources = 'Use at most 12 sources.';
  if (Array.isArray(rawSources) && downloadSources.length !== rawSources.length) errors.downloadSources = 'Every download option needs a valid HTTPS target URL.';
  if (Array.isArray(rawStreaming) && rawStreaming.length > 8) errors.streamingSources = 'Use at most 8 streaming sources.';
  if (subtitleUrl && !/^\/media\/subtitles\/[a-f0-9-]{36}\.(?:srt|vtt|zip|7z)$/.test(subtitleUrl)) errors.subtitleUrl = 'Upload a subtitle SRT, VTT, ZIP, or 7Z file.';

  if (officialWatchUrl && !validateOutboundDestination('watch', officialWatchUrl)) errors.officialWatchUrl = 'Use an approved YouTube watch URL.';
  let normalizedTelegramChannel = telegramChannel;
  if (telegramUrl) {
    let parsedTelegram: URL | null = null;
    try { parsedTelegram = new URL(telegramUrl); } catch { parsedTelegram = null; }
    if (parsedTelegram?.hostname.toLowerCase() === 't.me' && !normalizedTelegramChannel) normalizedTelegramChannel = parsedTelegram.pathname.split('/').filter(Boolean)[0] ?? null;
    if (!validateOutboundDestination('telegram', telegramUrl, normalizedTelegramChannel ?? undefined)) errors.telegramUrl = 'Use a valid HTTPS download/source URL.';
  } else if (telegramChannel) errors.telegramUrl = 'Add a Telegram URL or clear the channel field.';

  if (rightsStatus === 'verified') {
    if (!rightsVerifiedAt || Date.parse(rightsVerifiedAt) > now) errors.rightsVerifiedAt = 'Verification time is required and cannot be in the future.';
    if (!rightsExpiresAt || Date.parse(rightsExpiresAt) <= now) errors.rightsExpiresAt = 'A future expiry time is required.';
    if (!rightsReviewer) errors.rightsReviewer = 'Reviewer is required.';
    if (!rightsReference) errors.rightsReference = 'Evidence reference is required.';
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: {
    slug, title, tagline, description, year: Number(year), runtime, rating: Number(rating), contentType: contentType as 'movie' | 'series', genre: [...new Set(selectedGenres)].join(', '), director,
    cast, languages, poster, backdrop, featured: source.featured as boolean,
    publicationStatus: publicationStatus as PublicationStatus, rightsStatus: rightsStatus as RightsStatus,
    rightsVerifiedAt, rightsExpiresAt, rightsReviewer, rightsReference, officialWatchUrl, telegramUrl, telegramChannel: normalizedTelegramChannel, subtitleUrl, streamingSources, downloadSources, downloadStatus, episodes,
  } };
}
