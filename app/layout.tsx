import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { serializeJsonLd } from '../lib/security/json-ld';

const SITE_ORIGIN = 'https://flixlyra.com';

const siteStructuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_ORIGIN}/#organization`,
      name: 'Flixlyra',
      url: SITE_ORIGIN,
      logo: {
        '@type': 'ImageObject',
        url: `${SITE_ORIGIN}/og.png`,
        width: 1680,
        height: 945,
      },
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_ORIGIN}/#website`,
      name: 'Flixlyra',
      url: SITE_ORIGIN,
      description:
        'Discover global cinema through 10+ subtitle languages in a calm, premium movie experience.',
      publisher: { '@id': `${SITE_ORIGIN}/#organization` },
    },
  ],
};

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://flixlyra.com'),
  alternates: {
    canonical: '/',
  },
  title: 'Flixlyra — One Film. Many Languages.',
  description:
    'Discover global cinema through 10+ subtitle languages in a calm, premium movie experience.',
  openGraph: {
    url: 'https://flixlyra.com/',
    siteName: 'Flixlyra',
    type: 'website',
    locale: 'en_US',
    title: 'Flixlyra — One Film. Many Languages. Global Audience.',
    description: 'Discover global cinema through 10+ subtitle languages.',
    images: [
      {
        url: '/og.png',
        width: 1680,
        height: 945,
        alt: 'Flixlyra cinematic coastline and lantern',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Flixlyra — One Film. Many Languages.',
    description: 'Discover global cinema through 10+ subtitle languages.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const nonce = headers().then((requestHeaders) => requestHeaders.get('x-csp-nonce') ?? undefined);
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SiteStructuredData noncePromise={nonce} />
        {children}
      </body>
    </html>
  );
}

async function SiteStructuredData({ noncePromise }: { noncePromise: Promise<string | undefined> }) {
  const nonce = await noncePromise;
  return (
    <script
      suppressHydrationWarning
      nonce={nonce}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(siteStructuredData) }}
    />
  );
}
