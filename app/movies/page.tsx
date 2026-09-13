import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Movies — Flixlyra',
  description: 'Browse the published Flixlyra movie catalogue.',
  alternates: { canonical: '/movies' },
};

export { default } from '../page';
