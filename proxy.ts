import { NextResponse, type NextRequest } from 'next/server';

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
    if (decoded.includes('/') || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) return '/';
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

function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data:",
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

export function proxy(request: NextRequest) {
  const redirect = workersDevRedirect(request);
  if (redirect) return redirect;
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
