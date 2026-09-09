import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

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
  title: 'Flixlyra — One Film. Many Languages.',
  description:
    'Discover global cinema through 10+ subtitle languages in a calm, premium movie experience.',
  openGraph: {
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
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
