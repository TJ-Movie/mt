'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Menu,
  Play,
  Search,
  Sparkles,
  Star,
  X,
} from 'lucide-react';
import type { PublicMovie } from '../lib/public-movie';
import { allLanguages, contentTypes, genres } from '../lib/catalogue-options';

export function MovieBrowser({
  movies,
  adsEnabled,
}: {
  movies: PublicMovie[];
  adsEnabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('All');
  const [language, setLanguage] = useState('All languages');
  const [contentType, setContentType] = useState('all');
  const [menu, setMenu] = useState(false);
  const featuredMovies = useMemo(
    () => movies.filter((movie) => movie.featured),
    [movies],
  );
  const heroMovies =
    featuredMovies.length > 0 ? featuredMovies : movies.slice(0, 1);
  const [heroIndex, setHeroIndex] = useState(0);
  const filtered = useMemo(
    () =>
      movies.filter((movie) => {
        const castNames = movie.cast
          .map((person) =>
            typeof person === 'string'
              ? person
              : `${person.actor} ${person.character ?? ''}`,
          )
          .join(' ');
        const matchesQuery = `${movie.title} ${movie.director} ${castNames}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());
        const movieGenres = movie.genre.split(',').map((item) => item.trim());
        return (
          matchesQuery &&
          (genre === 'All' || movieGenres.includes(genre)) &&
          (language === 'All languages' ||
            movie.languages.includes(language)) &&
          (contentType === 'all' || movie.contentType === contentType)
        );
      }),
    [movies, query, genre, language, contentType],
  );

  useEffect(() => {
    if (heroMovies.length < 2) return;
    const timer = window.setInterval(() => {
      setHeroIndex((index) => (index + 1) % heroMovies.length);
    }, 6500);
    return () => window.clearInterval(timer);
  }, [heroMovies.length]);

  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options?: { signal?: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'filter_flixlyra_movies',
          title: 'Filter Flixlyra movies',
          description:
            'Filter the visible catalogue by search text, title type, genre, or subtitle language.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              type: { type: 'string' },
              genre: { type: 'string' },
              language: { type: 'string' },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input: unknown) {
            if (!input || typeof input !== 'object')
              throw new Error('Filter input must be an object.');
            const values = input as {
              query?: unknown;
              type?: unknown;
              genre?: unknown;
              language?: unknown;
            };
            if (typeof values.query === 'string')
              setQuery(values.query.slice(0, 80));
            if (typeof values.genre === 'string') {
              if (!genres.includes(values.genre))
                throw new Error('Unknown genre.');
              setGenre(values.genre);
            }
            if (typeof values.type === 'string') {
              if (
                values.type !== 'all' &&
                !contentTypes.includes(
                  values.type as (typeof contentTypes)[number],
                )
              )
                throw new Error('Unknown title type.');
              setContentType(values.type);
            }
            if (typeof values.language === 'string') {
              if (
                values.language !== 'All languages' &&
                !allLanguages.includes(values.language)
              )
                throw new Error('Unknown subtitle language.');
              setLanguage(values.language);
            }
            return {
              status: 'filtered',
              query:
                typeof values.query === 'string'
                  ? values.query.slice(0, 80)
                  : query,
              genre: typeof values.genre === 'string' ? values.genre : genre,
              language:
                typeof values.language === 'string'
                  ? values.language
                  : language,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [query, genre, language, contentType]);

  if (!heroMovies.length)
    return (
      <main className="min-h-screen overflow-hidden bg-neutral-950 text-white">
        <header className="flixlyra-glass relative z-50 text-white">
          <div className="mx-auto flex h-[50px] max-w-[1480px] items-center px-4 sm:h-20 sm:px-8 lg:px-12">
            <a href="#top" className="font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl">
              Flixlyra<span className="text-[#ef796d]">.</span>
            </a>
            <nav className="mx-auto hidden items-center gap-8 text-sm font-medium text-white/70 lg:flex">
              <a className="text-white" href="#top">Discover</a>
              <a href="#movie-grid">Movies</a>
              <a href="#languages">Languages</a>
              <a href="/content-policy">Content policy</a>
            </nav>
            <a href="#top" className="ml-auto hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/85 sm:flex">
              <Search size={15} /> Search
            </a>
          </div>
        </header>
        <section id="top" className="max-w-3xl mx-auto py-16 px-4 text-center">
          <span className="bg-neutral-900/80 text-neutral-400 border border-neutral-800 px-3 py-1 rounded-full text-xs font-mono inline-block mb-4">SYSTEM STATUS: CATALOG PREPARATION</span>
          <h1 className="text-3xl md:text-5xl font-bold text-white tracking-tight">Curated Cinema Arriving Soon</h1>
          <p className="text-neutral-400 text-sm md:text-base mt-4 max-w-xl mx-auto">Our catalog is being curated for a premium multi-device cinematic experience. Check back shortly.</p>
        </section>
        <section id="movie-grid" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 mt-12 max-w-6xl mx-auto px-4" aria-label="Upcoming catalogue">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="aspect-[2/3] overflow-hidden rounded-xl border border-white/10 bg-neutral-900/95 shadow-lg animate-pulse relative">
              <div className="bg-gradient-to-tr from-cyan-500/10 via-transparent to-blue-500/10 w-full h-full" />
            </div>
          ))}
        </section>
        <footer className="mx-auto mt-16 flex max-w-6xl flex-col gap-4 border-t border-white/10 px-4 py-7 text-sm text-white/40 sm:flex-row sm:justify-between">
          <span>© 2026 Flixlyra. Cinema in every language.</span>
          <span className="flex flex-wrap gap-x-5 gap-y-3">
            <a href="/privacy">Privacy</a>
            <a href="/content-policy">Content policy</a>
            <a href="/advertise">Advertise</a>
          </span>
        </footer>
      </main>
    );

  return (
    <main className="min-h-screen overflow-hidden bg-[#f2efe9] text-[#181916]">
      <header className="flixlyra-glass fixed inset-x-0 top-0 z-50 text-white">
        <div className="mx-auto flex h-[50px] max-w-[1480px] items-center px-4 sm:h-20 sm:px-8 lg:px-12">
          <a
            href="#top"
            className="font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl"
          >
            Flixlyra<span className="text-[#ef796d]">.</span>
          </a>
          <nav className="mx-auto hidden items-center gap-8 text-sm font-medium text-white/70 lg:flex">
            <a className="text-white" href="#discover">
              Discover
            </a>
            <a href="#movie-grid">Movies</a>
            <a href="#languages">Languages</a>
            <a href="/content-policy">Content policy</a>
          </nav>
          <a
            href="#discover"
            className="ml-auto hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/85 sm:flex"
          >
            <Search size={15} /> Search
          </a>
          <button
            onClick={() => setMenu(!menu)}
            className="ml-auto grid size-11 place-items-center text-white lg:size-10 lg:hidden"
            aria-label="Toggle navigation"
          >
            {menu ? <X /> : <Menu />}
          </button>
        </div>
        {menu && (
          <nav className="grid gap-1 border-t border-white/10 px-4 py-3 text-sm text-white/80 sm:px-8 lg:hidden">
            <a className="rounded-lg px-2 py-3" href="#discover">
              Discover
            </a>
            <a className="rounded-lg px-2 py-3" href="#movie-grid">
              Movies
            </a>
            <a className="rounded-lg px-2 py-3" href="#languages">
              Languages
            </a>
            <a className="rounded-lg px-2 py-3" href="/content-policy">
              Content policy
            </a>
          </nav>
        )}
      </header>

      <section
        id="top"
        aria-roledescription="carousel"
        aria-label="Featured content"
        className="relative h-[42vh] min-h-[280px] max-h-[42vh] overflow-hidden pt-[50px] sm:h-auto sm:min-h-[760px] sm:max-h-none sm:pt-20"
      >
        {heroMovies.map((movie, index) => {
          const active = index === heroIndex;
          const href = contentHref(movie);
          return (
            <article
              key={movie.slug}
              aria-hidden={!active}
              aria-label={`${index + 1} of ${heroMovies.length}: ${movie.title}`}
              className={`absolute inset-0 pt-[50px] transition-[opacity,transform] duration-1000 ease-out motion-reduce:transition-none sm:pt-20 ${active ? 'z-10 translate-x-0 opacity-100' : 'pointer-events-none z-0 translate-x-4 opacity-0'}`}
            >
              <img
                src={movie.backdrop}
                alt=""
                className="absolute inset-0 h-full w-full scale-[1.02] object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/75 via-40% to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-transparent to-black/30" />
              <div className="relative mx-auto flex h-full min-h-0 max-w-[1480px] items-end px-4 py-6 pb-10 text-white sm:h-auto sm:min-h-[680px] sm:items-end sm:px-8 sm:py-0 sm:pb-0 lg:items-center lg:px-12">
                <div className="relative z-10 w-full max-w-3xl sm:pt-24">
                  <div className="mb-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-[.2em] text-white/65 drop-shadow-md sm:mb-7 sm:tracking-[.25em]">
                    <span className="h-px w-8 bg-[#de5d4f] sm:w-10" />{' '}
                    {featuredMovies.length
                      ? 'Featured content'
                      : 'Latest release'}
                  </div>
                  <a
                    href={href}
                    tabIndex={active ? 0 : -1}
                    className="group inline-block max-w-full"
                  >
                    <h1 className="break-words font-serif text-xl leading-tight tracking-[-.055em] drop-shadow-md transition-colors group-hover:text-[#f3aaa2] sm:text-4xl lg:text-[7.5rem]">
                      {movie.title}
                    </h1>
                  </a>
                  <p className="mt-4 font-serif text-lg italic text-white/65 drop-shadow-md sm:mt-5 sm:text-2xl">
                    {movie.tagline}
                  </p>
                  <div className="mt-2 flex flex-nowrap items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs text-white/70 drop-shadow-md sm:mt-7 sm:flex-wrap sm:gap-x-5 sm:gap-y-2 sm:text-sm">
                    <span className="flex items-center gap-1.5">
                      <Star
                        size={14}
                        className="fill-[#de5d4f] text-[#de5d4f]"
                      />{' '}
                      {movie.rating}
                    </span>
                    <span>{movie.year}</span>
                    <span>{movie.runtime}</span>
                    <span className="hidden sm:inline">{movie.genre}</span>
                    <span>{movie.languages.length} subs<span className="hidden sm:inline">title languages</span></span>
                  </div>
                  <p className="mt-5 hidden max-w-xl text-base leading-7 text-white/65 drop-shadow-md sm:mt-6 sm:block">
                    {movie.description}
                  </p>
                  <div className="mt-4 flex w-full flex-row gap-2 sm:mt-8 sm:flex-wrap">
                    <a
                      href={href}
                      tabIndex={active ? 0 : -1}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-[#de5d4f] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#c64d40] sm:min-h-12 sm:flex-none sm:gap-3 sm:px-6 sm:py-3.5 sm:text-sm"
                    >
                      Explore this{' '}
                      {movie.contentType === 'series' ? 'series' : 'film'}{' '}
                      <ArrowRight size={17} />
                    </a>
                    <button
                      type="button"
                      onClick={() =>
                        document
                          .getElementById('movie-grid')
                          ?.scrollIntoView({ behavior: 'smooth' })
                      }
                      tabIndex={active ? 0 : -1}
                      className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-full border border-white/25 bg-black/45 px-3 py-2 text-xs font-semibold sm:min-h-12 sm:flex-none sm:px-6 sm:py-3.5 sm:text-sm"
                    >
                      <Search size={16} /> Search all films
                    </button>
                  </div>
                </div>
              </div>
            </article>
          );
        })}
        {heroMovies.length > 1 ? (
          <div className="absolute inset-x-0 bottom-2 z-30 mx-auto flex max-w-[1480px] items-center justify-between px-3 text-white sm:bottom-7 sm:justify-start sm:gap-3 sm:px-8 lg:px-12">
            <button
              type="button"
              onClick={() =>
                setHeroIndex(
                  (index) =>
                    (index - 1 + heroMovies.length) % heroMovies.length,
                )
              }
              className="grid size-11 place-items-center rounded-full border border-white/20 bg-black/45 transition hover:bg-black/75 sm:border-white/25 sm:bg-black/55"
              aria-label="Previous featured title"
            >
              <ChevronLeft size={20} />
            </button>
            <div
              className="flex items-center gap-1 sm:gap-2"
              role="tablist"
              aria-label="Choose featured title"
            >
              {heroMovies.map((movie, index) => (
                <button
                  key={movie.slug}
                  type="button"
                  role="tab"
                  aria-selected={index === heroIndex}
                  aria-label={`Show ${movie.title}`}
                  onClick={() => setHeroIndex(index)}
                  className={`h-1 rounded-full transition-all sm:h-1.5 ${index === heroIndex ? 'w-6 bg-[#ef796d] sm:w-10' : 'w-3 bg-white/40 hover:bg-white/70 sm:w-5'}`}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setHeroIndex((index) => (index + 1) % heroMovies.length)
              }
              className="grid size-11 place-items-center rounded-full border border-white/20 bg-black/45 transition hover:bg-black/75 sm:border-white/25 sm:bg-black/55"
              aria-label="Next featured title"
            >
              <ChevronRight size={20} />
            </button>
            <span
              className="ml-1 hidden text-xs font-semibold tracking-[.18em] text-white/60 sm:inline"
              aria-live="polite"
            >
              {String(heroIndex + 1).padStart(2, '0')} /{' '}
              {String(heroMovies.length).padStart(2, '0')}
            </span>
          </div>
        ) : null}
        <div className="absolute bottom-0 right-0 hidden w-[330px] border-l border-t border-white/15 bg-black/75 p-6 text-white xl:block">
          <div className="flex items-center gap-3">
            <Globe2 className="text-[#ef796d]" />
            <div>
              <p className="text-xs uppercase tracking-[.18em] text-white/45">
                Subtitle coverage
              </p>
              <p className="mt-1 font-serif text-xl">One film. Many voices.</p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="discover"
        className="mx-auto my-2 max-w-[1480px] px-4 py-1 sm:my-10 sm:px-8 sm:py-20 lg:px-12"
      >
        <div className="grid gap-2 lg:grid-cols-[.65fr_1.35fr] lg:items-end lg:gap-8">
          <div className="hidden md:block">
            <p className="section-kicker">Curated cinema</p>
            <h2 className="mt-3 max-w-lg font-serif text-4xl leading-[.98] tracking-[-.04em] sm:text-6xl">
              Find your next story.
            </h2>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1 sm:grid-cols-[1fr_180px_210px] sm:gap-3">
            <div className="flex min-w-0 items-center gap-1 sm:contents">
              <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-stone-300/80 bg-white/70 px-2 text-stone-900 transition-colors hover:border-stone-400 focus-within:border-stone-500 focus-within:bg-white sm:h-auto sm:min-h-12 sm:gap-3 sm:rounded-xl sm:px-4 sm:py-3">
              <Search size={18} className="shrink-0 text-stone-500" />
              <input
                value={query}
                maxLength={80}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, director or cast"
                className="h-9 min-w-0 w-full bg-transparent text-xs outline-none placeholder:text-stone-500 sm:h-auto sm:text-sm"
              />
              </label>
              <span className="shrink-0 rounded-full bg-stone-200 px-2 py-1 text-[11px] font-semibold text-stone-700 sm:hidden">
                {filtered.length} films
              </span>
            </div>
            <FilterSelect
              label="Genre"
              value={genre}
              options={genres}
              onChange={setGenre}
            />
            <FilterSelect
              label="Subtitle"
              value={language}
              options={['All languages', ...allLanguages]}
              onChange={setLanguage}
            />
          </div>
        </div>
      </section>

      <div className="mx-auto mb-2 max-w-[1480px] px-4 sm:mb-0 sm:px-8 lg:px-12">
        <div className="max-w-[180px]">
          <FilterSelect
            label="Type"
            value={contentType}
            options={['all', ...contentTypes]}
            onChange={setContentType}
          />
        </div>
      </div>

      <section
        id="movie-grid"
        className="mx-auto max-w-[1480px] px-4 pb-16 sm:px-8 sm:pb-20 lg:px-12"
      >
        <div className="mb-4 hidden items-end justify-between border-b border-black/15 pb-3 sm:flex sm:mb-8 sm:pb-4">
          <p className="text-sm text-black/50">
            {filtered.length} {filtered.length === 1 ? 'film' : 'films'} found
          </p>
          <span className="hidden text-xs uppercase tracking-[.2em] text-black/40 md:block">
            Updated weekly
          </span>
        </div>
        {filtered.length ? (
          <>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-10 lg:grid-cols-5">
              {filtered.map((movie) => (
                <a key={movie.slug} href={contentHref(movie)} className="group text-stone-900">
                  <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-stone-200 shadow-[0_12px_30px_rgba(41,37,36,0.16)]">
                    <img
                      src={movie.poster}
                      alt={`${movie.title} poster`}
                      className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]"
                    />
                    <div className="absolute inset-0 bg-stone-900/0 transition group-hover:bg-stone-900/10" />
                    <span className="absolute right-1.5 top-1.5 rounded-sm border border-stone-300/80 bg-white/85 px-1.5 py-1 text-[10px] font-bold text-stone-900 sm:right-3 sm:top-3 sm:px-2 sm:text-xs">
                      ★ {movie.rating.toFixed(1)}
                    </span>
                    <span className="absolute bottom-3 right-3 grid size-11 place-items-center rounded-full bg-[#de5d4f] text-white opacity-100 transition sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100">
                      <Play size={16} fill="currentColor" />
                    </span>
                  </div>
                  <div className="mt-3 flex items-start gap-2 sm:mt-4 sm:gap-3">
                    <div className="min-w-0">
                      <h3 className="block min-h-5 w-full line-clamp-2 font-serif text-sm font-semibold leading-tight text-stone-900 sm:min-h-0 sm:break-words sm:whitespace-normal sm:overflow-visible sm:text-xl">
                        {movie.title}
                      </h3>
                      <p className="mt-1.5 text-xs text-stone-600 sm:text-sm">
                        {movie.year} · {movie.runtime}
                      </p>
                    </div>
                  </div>
                </a>
              ))}
            </div>
            {adsEnabled ? (
              <aside
                aria-label="Advertisement"
                className="mt-14 grid min-h-28 place-items-center border border-dashed border-black/20 bg-white/20 px-6 text-center"
              >
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[.22em] text-black/35">
                    Advertisement
                  </p>
                  <p className="mt-2 text-sm text-black/45">
                    Reserved for a verified cinema or entertainment partner
                  </p>
                </div>
              </aside>
            ) : null}
          </>
        ) : (
          <div className="border border-dashed border-black/20 py-16 text-center">
            <Sparkles className="mx-auto mb-3 text-black/25" />
            <p className="font-serif text-2xl">No film found</p>
            <button
              onClick={() => {
                setQuery('');
                setGenre('All');
                setLanguage('All languages');
              }}
              className="mt-3 min-h-11 text-sm text-[#b43a2e] underline underline-offset-4"
            >
              Clear all filters
            </button>
          </div>
        )}
      </section>

      <section id="languages" className="bg-[#1a1b18] text-white">
        <div className="mx-auto grid max-w-[1480px] gap-8 px-4 py-14 sm:gap-10 sm:px-8 sm:py-20 lg:grid-cols-[.8fr_1.2fr] lg:px-12">
          <div>
            <p className="section-kicker text-[#ef796d]">Built for the world</p>
            <h2 className="mt-4 font-serif text-4xl leading-none tracking-[-.04em] sm:text-5xl">
              Every language opens another door.
            </h2>
          </div>
          <div className="flex flex-wrap content-start gap-2 pt-2">
            {allLanguages.map((item, index) => (
              <button
                key={item}
                onClick={() => {
                  setLanguage(item);
                  location.hash = 'discover';
                }}
                className="min-h-11 rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/70 transition hover:border-[#ef796d] hover:text-white"
              >
                <span className="mr-2 text-xs text-white/30">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {item}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section
        id="about"
        className="mx-auto max-w-[1480px] px-4 py-14 sm:px-8 sm:py-16 lg:px-12"
      >
        <div className="grid gap-8 border-b border-black/15 pb-14 md:grid-cols-3">
          <div>
            <p className="font-serif text-3xl">
              Flixlyra<span className="text-[#b43a2e]">.</span>
            </p>
            <p className="mt-3 max-w-xs text-base leading-7 text-black/50">
              One film. Many languages. A calm place to discover cinema across
              borders.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.18em]">
              Responsible delivery
            </p>
            <p className="mt-3 text-base leading-7 text-black/50">
              Watch and Telegram links are added only for content the publisher
              is authorised to distribute.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.18em]">
              Advertise responsibly
            </p>
            <p className="mt-3 text-base leading-7 text-black/50">
              Clear labels, no pop-ups, and no buttons designed to mislead
              visitors.
            </p>
            <a
              href="/advertise"
              className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[#b43a2e] underline underline-offset-4"
            >
              Partnership information
            </a>
          </div>
        </div>
        <footer className="flex flex-col gap-4 py-7 text-sm text-black/40 sm:flex-row sm:justify-between">
          <span>© 2026 Flixlyra. Cinema in every language.</span>
          <span className="flex flex-wrap gap-x-5 gap-y-3">
            <a href="/privacy">Privacy</a>
            <a href="/content-policy">Content policy</a>
            <a href="/advertise">Advertise</a>
          </span>
        </footer>
      </section>
    </main>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative flex h-11 min-h-11 min-w-0 items-center rounded-lg border border-stone-300/80 bg-stone-200/50 px-2 text-stone-900 transition-colors hover:border-stone-400 focus-within:border-stone-500 focus-within:bg-white/70 sm:h-auto sm:min-h-12 sm:rounded-xl sm:px-4">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 min-w-0 w-full appearance-none truncate bg-transparent pr-4 text-xs text-stone-900 outline-none sm:h-12 sm:pr-7 sm:text-sm"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-2 top-3.5 text-stone-500 sm:right-4 sm:top-4"
      />
    </label>
  );
}

function contentHref(movie: PublicMovie): string {
  return `/${movie.contentType === 'series' ? 'series' : 'movie'}/${movie.slug}`;
}
