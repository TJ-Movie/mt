export type Movie = {
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
  languages: string[];
  poster: string;
  backdrop: string;
  featured?: boolean;
  officialWatchUrl?: string;
  telegramUrl?: string;
};

export const allLanguages = ['English', 'Sinhala', 'Hindi', 'Tamil', 'Spanish', 'French', 'Portuguese', 'Arabic', 'Japanese', 'Korean', 'German'];
export const genres = ['All', 'Adventure', 'Drama', 'Sci-Fi', 'Thriller', 'Action'];

export const movies: Movie[] = [
  {
    slug: 'the-last-lantern',
    title: 'The Last Lantern',
    tagline: 'One light can cross every border.',
    description: 'When a coastal village loses contact with the outside world, a young archivist follows the glow of an ancient lantern into a story shared across generations and languages.',
    year: 2026,
    runtime: '2h 14m',
    rating: 8.9,
    genre: 'Adventure',
    director: 'Mira Senanayake',
    cast: ['Anika Perera', 'Ravi Mehta', 'Sora Kim', 'Nadia Laurent'],
    languages: allLanguages,
    poster: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=900&q=88',
    backdrop: 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=2200&q=90',
    featured: true,
  },
  {
    slug: 'silent-horizon', title: 'Silent Horizon', tagline: 'The signal was never meant for us.',
    description: 'A deep-space linguist deciphers a transmission that changes the meaning of home.', year: 2025, runtime: '1h 58m', rating: 8.4, genre: 'Sci-Fi', director: 'Jonas Vale', cast: ['Elena Moss', 'Theo Reed', 'Ari Kato'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Spanish', 'French', 'Japanese'], poster: 'https://images.unsplash.com/photo-1446776877081-d282a0f896e2?auto=format&fit=crop&w=900&q=85', backdrop: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=2200&q=90'
  },
  {
    slug: 'monsoon-letters', title: 'Monsoon Letters', tagline: 'Some words arrive with the rain.',
    description: 'Two families find their histories intertwined through letters hidden for four decades.', year: 2025, runtime: '2h 03m', rating: 8.2, genre: 'Drama', director: 'Ishani Rao', cast: ['Maya Dias', 'Kabir Bose', 'Lena Silva'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Portuguese', 'Arabic'], poster: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85', backdrop: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=2200&q=90'
  },
  {
    slug: 'red-line', title: 'Red Line', tagline: 'Every stop hides a secret.',
    description: 'A night-train conductor has one hour to expose a conspiracy before the final station.', year: 2024, runtime: '1h 46m', rating: 7.9, genre: 'Thriller', director: 'Marco Elian', cast: ['Tara Wynn', 'Jun Park', 'Omar Aziz'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'Spanish', 'Korean'], poster: 'https://images.unsplash.com/photo-1517994112540-009c47ea476b?auto=format&fit=crop&w=900&q=85', backdrop: 'https://images.unsplash.com/photo-1486911278844-a81c5267e227?auto=format&fit=crop&w=2200&q=90'
  },
  {
    slug: 'kingdom-of-dust', title: 'Kingdom of Dust', tagline: 'The past remembers everything.',
    description: 'An exiled historian returns to a desert citadel to prevent a forgotten war from beginning again.', year: 2024, runtime: '2h 21m', rating: 8.1, genre: 'Action', director: 'Amir Sol', cast: ['Lea Morgan', 'Dev Arora', 'Min Seo'], languages: ['English', 'Sinhala', 'Hindi', 'Tamil', 'French', 'Arabic', 'German'], poster: 'https://images.unsplash.com/photo-1506461883276-594a12b11cf3?auto=format&fit=crop&w=900&q=85', backdrop: 'https://images.unsplash.com/photo-1509316785289-025f5b846b35?auto=format&fit=crop&w=2200&q=90'
  },
  {
    slug: 'after-midnight', title: 'After Midnight', tagline: 'The city speaks when everyone sleeps.',
    description: 'A radio host receives a call from tomorrow and races to change one impossible night.', year: 2025, runtime: '1h 52m', rating: 7.8, genre: 'Thriller', director: 'Nora Flint', cast: ['Evan Cole', 'Sana Mir', 'Hugo Lane'], languages: ['English', 'Sinhala', 'Hindi', 'Spanish', 'French', 'Portuguese', 'Japanese'], poster: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=900&q=85', backdrop: 'https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=2200&q=90'
  },
];

export function getMovie(slug: string) {
  return movies.find((movie) => movie.slug === slug);
}
