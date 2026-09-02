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
  title: 'Cinewave — Movies with Sinhala Subtitles',
  description: 'Discover cinema, TV series, and fresh weekly releases with Sinhala subtitles.',
  openGraph: {
    title: 'Cinewave — Cinema, discovered differently.',
    description: 'Discover cinema, TV series, and fresh weekly releases with Sinhala subtitles.',
    images: [{ url: '/og.png', width: 1680, height: 945, alt: 'Cinewave cinematic desert artwork' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Cinewave — Cinema, discovered differently.',
    description: 'Discover cinema, TV series, and fresh weekly releases with Sinhala subtitles.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
