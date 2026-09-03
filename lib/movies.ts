import 'server-only';
import { allLanguages } from './catalogue-options.ts';

export const rightsStatuses = ['pending', 'verified', 'blocked'] as const;
export type RightsStatus = (typeof rightsStatuses)[number];
export const publicationStatuses = ['draft', 'published', 'archived'] as const;
export type PublicationStatus = (typeof publicationStatuses)[number];

export type Movie = {
  contentType?: 'movie' | 'series';
  slug: string;
  title: string;
  tagline: string;
  description: string;
  year: number;
  runtime: string;
  rating: number;
  genre: string;
  director: string;
  cast: string[];
  languages: readonly string[];
  poster: string;
  backdrop: string;
  featured?: boolean;
  publicationStatus: PublicationStatus;
  rightsStatus: RightsStatus;
  rightsVerifiedAt?: string;
  rightsExpiresAt?: string;
  rightsReviewer?: string;
  rightsReference?: string;
  officialWatchUrl?: string;
  telegramUrl?: string;
  telegramChannel?: string;
  subtitleUrl?: string;
};

export const movies: Movie[] = [
  {
    slug: 'the-last-lantern',
    title: 'The Last Lantern',
    tagline: 'One light can cross every border.',
    description: 'When a coastal village loses contact with the outside world, a young archivist follows the glow of an ancient lantern into a story shared across generations and languages.',
    year: 2026,
    runtime: '2h 14m',
    rating: 8.9,
    publicationStatus: 'published',
    rightsStatus: 'pending',
    genre: 'Adventure',
    director: 'Mira Senanayake',
    cast: ['Anika Perera', 'Ravi Mehta', 'Sora Kim', 'Nadia Laurent'],
    languages: allLanguages,
    poster: '/og.png',
    backdrop: '/og.png',
    featured: true,
  },
  {
    slug: 'silent-horizon', title: 'Silent Horizon', tagline: 'The signal was never meant for us.',
    description: 'A deep-space linguist deciphers a transmission that changes the meaning of home.', year: 2025, runtime: '1h 58m', rating: 8.4, publicationStatus: 'published', rightsStatus: 'pending', genre: 'Sci-Fi', director: 'Jonas Vale', cast: ['Elena Moss', 'Theo Reed', 'Ari Kato'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Spanish', 'French', 'Japanese'], poster: '/og.png', backdrop: '/og.png'
  },
  {
    slug: 'monsoon-letters', title: 'Monsoon Letters', tagline: 'Some words arrive with the rain.',
    description: 'Two families find their histories intertwined through letters hidden for four decades.', year: 2025, runtime: '2h 03m', rating: 8.2, publicationStatus: 'published', rightsStatus: 'pending', genre: 'Drama', director: 'Ishani Rao', cast: ['Maya Dias', 'Kabir Bose', 'Lena Silva'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Portuguese', 'Arabic'], poster: '/og.png', backdrop: '/og.png'
  },
  {
    slug: 'red-line', title: 'Red Line', tagline: 'Every stop hides a secret.',
    description: 'A night-train conductor has one hour to expose a conspiracy before the final station.', year: 2024, runtime: '1h 46m', rating: 7.9, publicationStatus: 'published', rightsStatus: 'pending', genre: 'Thriller', director: 'Marco Elian', cast: ['Tara Wynn', 'Jun Park', 'Omar Aziz'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Spanish', 'Korean'], poster: '/og.png', backdrop: '/og.png'
  },
  {
    slug: 'kingdom-of-dust', title: 'Kingdom of Dust', tagline: 'The past remembers everything.',
    description: 'An exiled historian returns to a desert citadel to prevent a forgotten war from beginning again.', year: 2024, runtime: '2h 21m', rating: 8.1, publicationStatus: 'published', rightsStatus: 'pending', genre: 'Action', director: 'Amir Sol', cast: ['Lea Morgan', 'Dev Arora', 'Min Seo'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'French', 'Arabic', 'German'], poster: '/og.png', backdrop: '/og.png'
  },
  {
    slug: 'after-midnight', title: 'After Midnight', tagline: 'The city speaks when everyone sleeps.',
    description: 'A radio host receives a call from tomorrow and races to change one impossible night.', year: 2025, runtime: '1h 52m', rating: 7.8, publicationStatus: 'published', rightsStatus: 'pending', genre: 'Thriller', director: 'Nora Flint', cast: ['Evan Cole', 'Sana Mir', 'Hugo Lane'], languages: ['English', 'Sinhala', 'Hindi', 'Spanish', 'French', 'Portuguese', 'Japanese'], poster: '/og.png', backdrop: '/og.png'
  },
];

export function getMovie(slug: string) {
  return movies.find((movie) => movie.slug === slug);
}
