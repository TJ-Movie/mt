import { NextResponse, type NextRequest } from 'next/server';
import { env } from 'cloudflare:workers';

type RouteBindings = { DB?: D1Database };

const SITE_ORIGIN = 'https://flixlyra.com';

function sanitizePathname(pathname: string): string {
  const segments = pathname.split('/');
  const safeSegments: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') continue;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return '/';
    }
    if (decoded.includes('/') || decoded.includes('\\') || /\p{Cc}/u.test(decoded)) return '/';
    safeSegments.push(encodeURIComponent(decoded));
  }
  return `/${safeSegments.join('/')}`;
}

function workersDevRedirect(request: NextRequest): NextResponse | undefined {
  const hostname = request.nextUrl.hostname.toLowerCase();
  if (!/^(?:[a-z0-9-]+\.)+workers\.dev$/.test(hostname)) return undefined;
  const target = new URL(SITE_ORIGIN);
  target.pathname = sanitizePathname(request.nextUrl.pathname);
  target.search = request.nextUrl.search;
  return NextResponse.redirect(target, 301);
}

async function missingPublicMovieRoute(request: NextRequest): Promise<NextResponse | undefined> {
  const match = request.nextUrl.pathname.match(/^\/(movie|movies|series)\/([^/]+)\/?$/i);
  if (!match) return undefined;

  let slug: string;
  try {
    slug = decodeURIComponent(match[2]);
  } catch {
    return new NextResponse('Not Found', { status: 404 });
  }
  if (!slug || slug.includes('/') || slug.includes('\\') || /\p{Cc}/u.test(slug)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  let routeType: 'movie' | 'series' | undefined | null;
  try {
    const database = (env as unknown as RouteBindings).DB;
    if (!database) return undefined;
    const row = await database
      .prepare("SELECT content_type FROM movies WHERE slug = ? AND publication_status = 'published' LIMIT 1")
      .bind(slug)
      .first<{ content_type?: string }>();
    routeType = row
      ? row.content_type === 'series' ? 'series' : 'movie'
      : undefined;
  } catch {
    // Let the page pipeline handle database outages; do not create false 404s.
    return undefined;
  }
  if (routeType === null) return undefined;
  const requestedType = match[1].toLowerCase() === 'series' ? 'series' : 'movie';
  if (!routeType || routeType !== requestedType) return new NextResponse('Not Found', { status: 404 });
  return undefined;
}

function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data: https://flixlyra.com https://image.tmdb.org https://yts.mx https://*.yts.mx https://yts.lt https://*.yts.lt https://yts.am https://*.yts.am https://yts.rs https://*.yts.rs https://yts.pm https://*.yts.pm",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self'",
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export async function proxy(request: NextRequest) {
  const redirect = workersDevRedirect(request);
  if (redirect) return redirect;
  const missingRoute = await missingPublicMovieRoute(request);
  if (missingRoute) return missingRoute;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const policy = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-csp-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  response.headers.set('Referrer-Policy', 'no-referrer');
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && requestOrigin !== 'https://flixlyra.com') {
    return new NextResponse('Forbidden', { status: 403, headers: {
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    } });
  }
  if (requestOrigin === 'https://flixlyra.com') {
    response.headers.set('Access-Control-Allow-Origin', 'https://flixlyra.com');
    response.headers.append('Vary', 'Origin');
  }
  const existingCsrf = request.cookies.get('__Host-flixlyra-csrf')?.value;
  if (!existingCsrf || !/^[a-f0-9-]{36}$/.test(existingCsrf)) {
    response.cookies.set('__Host-flixlyra-csrf', crypto.randomUUID(), {
      httpOnly: false,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
  }
  return response;
}

export const config = { matcher: ['/(.*)'] };
