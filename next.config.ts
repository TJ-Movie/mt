import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'flixlyra.com', pathname: '/media/**' },
      { protocol: 'https', hostname: 'image.tmdb.org', pathname: '/**' },
      { protocol: 'https', hostname: 'yts.mx', pathname: '/**' },
      { protocol: 'https', hostname: '**.yts.mx', pathname: '/**' },
      { protocol: 'https', hostname: 'yts.lt', pathname: '/**' },
      { protocol: 'https', hostname: '**.yts.lt', pathname: '/**' },
      { protocol: 'https', hostname: 'yts.am', pathname: '/**' },
      { protocol: 'https', hostname: '**.yts.am', pathname: '/**' },
      { protocol: 'https', hostname: 'yts.rs', pathname: '/**' },
      { protocol: 'https', hostname: '**.yts.rs', pathname: '/**' },
      { protocol: 'https', hostname: 'yts.pm', pathname: '/**' },
      { protocol: 'https', hostname: '**.yts.pm', pathname: '/**' },
    ],
  },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      { source: '/studio/:path*', headers: [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      ] },
      { source: '/api/admin/:path*', headers: [
        { key: 'Cache-Control', value: 'no-store, max-age=0' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      ] },
    ];
  },
};

export default nextConfig;
