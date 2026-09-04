import type { Movie } from '../movies.ts';
import type { RuntimeControls } from './runtime-controls.ts';

export type OutboundAction = 'watch' | 'telegram';
export type OutboundDenialReason =
  | 'kill_switch'
  | 'rights_not_verified'
  | 'rights_metadata_invalid'
  | 'rights_expired'
  | 'missing_destination'
  | 'destination_invalid';

export type OutboundResolution =
  | Readonly<{ ok: true; target: URL }>
  | Readonly<{ ok: false; reason: OutboundDenialReason }>;

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_SHARE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TELEGRAM_CHANNEL = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TELEGRAM_MESSAGE_ID = /^\d{1,20}$/;

function hasUnexpectedUrlParts(url: URL): boolean {
  return Boolean(url.username || url.password || url.port || url.hash);
}

function hasOnlySearchParameters(url: URL, allowed: ReadonlySet<string>): boolean {
  return [...url.searchParams.keys()].every((key) => allowed.has(key));
}

function validateYouTube(url: URL): boolean {
  if (url.protocol !== 'https:' || hasUnexpectedUrlParts(url)) return false;

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'playmogo.com' || hostname === 'www.playmogo.com') {
    return /^\/e\/[A-Za-z0-9_-]{6,80}$/.test(url.pathname) && url.search === '';
  }
  if (hostname === 'youtu.be') {
    const videoId = url.pathname.slice(1);
    return (
      !videoId.includes('/') &&
      YOUTUBE_VIDEO_ID.test(videoId) &&
      hasOnlySearchParameters(url, new Set(['t', 'si'])) &&
      url.searchParams.getAll('si').length <= 1 &&
      (!url.searchParams.get('si') || YOUTUBE_SHARE_ID.test(url.searchParams.get('si')!))
    );
  }

  if (hostname !== 'www.youtube.com' || url.pathname !== '/watch') return false;
  const videoIds = url.searchParams.getAll('v');
  return (
    videoIds.length === 1 &&
    YOUTUBE_VIDEO_ID.test(videoIds[0]) &&
    hasOnlySearchParameters(url, new Set(['v', 't', 'si'])) &&
    url.searchParams.getAll('si').length <= 1 &&
    (!url.searchParams.get('si') || YOUTUBE_SHARE_ID.test(url.searchParams.get('si')!))
  );
}

function validateTelegram(url: URL, expectedChannel: string | undefined): boolean {
  if (url.hostname.toLowerCase() !== 't.me') return false;
  if (
    url.protocol !== 'https:' ||
    hasUnexpectedUrlParts(url) ||
    url.search !== '' ||
    expectedChannel !== undefined && !TELEGRAM_CHANNEL.test(expectedChannel)
  ) return false;

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return false;
  if (expectedChannel && segments[0].toLowerCase() !== expectedChannel.toLowerCase()) return false;
  return segments.length === 1 || TELEGRAM_MESSAGE_ID.test(segments[1]);
}

export function validateOutboundDestination(
  action: OutboundAction,
  destination: string,
  expectedTelegramChannel?: string,
): URL | null {
  let target: URL;
  try {
    target = new URL(destination);
  } catch {
    return null;
  }

  const valid = action === 'watch'
    ? validateYouTube(target)
    : validateTelegram(target, expectedTelegramChannel);
  return valid ? target : null;
}

function validRightsDate(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function resolveOutboundDestination(
  movie: Movie,
  action: OutboundAction,
  controls: RuntimeControls,
  now = Date.now(),
): OutboundResolution {
  if (!controls.externalLinksEnabled) return { ok: false, reason: 'kill_switch' };
  if (movie.rightsStatus !== 'verified') return { ok: false, reason: 'rights_not_verified' };

  const verifiedAt = validRightsDate(movie.rightsVerifiedAt);
  const expiresAt = validRightsDate(movie.rightsExpiresAt);
  if (
    verifiedAt === null ||
    verifiedAt > now ||
    !movie.rightsReviewer?.trim() ||
    !movie.rightsReference?.trim()
  ) return { ok: false, reason: 'rights_metadata_invalid' };
  if (expiresAt === null || expiresAt <= now) return { ok: false, reason: 'rights_expired' };

  const destination = action === 'watch' ? movie.officialWatchUrl : movie.telegramUrl;
  if (!destination) return { ok: false, reason: 'missing_destination' };

  const target = validateOutboundDestination(action, destination, movie.telegramChannel);
  return target
    ? { ok: true, target }
    : { ok: false, reason: 'destination_invalid' };
}
