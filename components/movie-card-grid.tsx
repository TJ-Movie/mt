import { Play } from 'lucide-react';

export type MovieCardGridItem = {
  slug: string;
  title: string;
  year: number;
  runtime: string;
  rating: number;
  poster: string;
  contentType?: 'movie' | 'series';
};

/** Shared original Flixlyra poster-card presentation for bounded public lists. */
export function MovieCardGrid({ movies }: { movies: readonly MovieCardGridItem[] }) {
  return (
    <div className='grid grid-cols-3 gap-3 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-10 lg:grid-cols-5'>
      {movies.map((movie) => (
        <a key={movie.slug} href={'/' + (movie.contentType === 'series' ? 'series' : 'movie') + '/' + movie.slug} className='group text-stone-900'>
          <div className='relative aspect-[2/3] overflow-hidden rounded-xl bg-stone-200 shadow-[0_12px_30px_rgba(41,37,36,0.16)]'>
            <img
              src={movie.poster}
              alt={`${movie.title} poster`}
              className='h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]'
              loading='lazy'
              decoding='async'
            />
            <div className='absolute inset-0 bg-stone-900/0 transition group-hover:bg-stone-900/10' />
            <span className='absolute right-1.5 top-1.5 rounded-sm border border-stone-300/80 bg-white/85 px-1.5 py-1 text-[10px] font-bold text-stone-900 sm:right-3 sm:top-3 sm:px-2 sm:text-xs'>
              ★ {movie.rating.toFixed(1)}
            </span>
            <span className='absolute bottom-3 right-3 grid size-11 place-items-center rounded-full bg-[#de5d4f] text-white opacity-100 transition sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100'>
              <Play size={16} fill='currentColor' />
            </span>
          </div>
          <div className='mt-3 flex items-start gap-2 sm:mt-4 sm:gap-3'>
            <div className='min-w-0'>
              <h3 className='block min-h-5 w-full line-clamp-2 font-serif text-sm font-semibold leading-tight text-stone-900 sm:min-h-0 sm:break-words sm:whitespace-normal sm:overflow-visible sm:text-xl'>
                {movie.title}
              </h3>
              <p className='mt-1.5 text-xs text-stone-600 sm:text-sm'>
                {movie.year} · {movie.runtime}
              </p>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}
