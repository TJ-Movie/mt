'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Menu, Play, Search, Sparkles } from 'lucide-react';
import type { PublicMovie } from '../lib/public-movie';
import { allLanguages, contentTypes, genres } from '../lib/catalogue-options';

type CatalogueFilters = {
  query: string;
  genre: string;
  language: string;
  contentType: string;
};

type MovieCatalogueProps = {
  movies: PublicMovie[];
  adsEnabled: boolean;
  initialFilters: CatalogueFilters;
  hasNextPage: boolean;
};

const PAGE_SIZE = 24;
const DEFAULT_FILTERS: CatalogueFilters = {
  query: '',
  genre: 'All',
  language: 'All languages',
  contentType: 'all',
};

function filtersFromLocation(): CatalogueFilters {
  const params = new URLSearchParams(window.location.search);
  return {
    query: params.get('q') ?? '',
    genre: params.get('genre') ?? DEFAULT_FILTERS.genre,
    language: params.get('language') ?? DEFAULT_FILTERS.language,
    contentType: params.get('type') ?? DEFAULT_FILTERS.contentType,
  };
}

function filtersQueryString(filters: CatalogueFilters): string {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set('q', filters.query.trim());
  if (filters.genre !== DEFAULT_FILTERS.genre) params.set('genre', filters.genre);
  if (filters.language !== DEFAULT_FILTERS.language) params.set('language', filters.language);
  if (filters.contentType !== DEFAULT_FILTERS.contentType) params.set('type', filters.contentType);
  return params.toString();
}

function contentHref(movie: PublicMovie): string {
  return '/' + (movie.contentType === 'series' ? 'series' : 'movie') + '/' + movie.slug;
}

export function MovieCatalogue({ movies: initialMovies, adsEnabled, initialFilters, hasNextPage: initialHasNextPage }: MovieCatalogueProps) {
  const [query, setQuery] = useState(initialFilters.query || DEFAULT_FILTERS.query);
  const [genre, setGenre] = useState(initialFilters.genre || DEFAULT_FILTERS.genre);
  const [language, setLanguage] = useState(initialFilters.language || DEFAULT_FILTERS.language);
  const [contentType, setContentType] = useState(initialFilters.contentType || DEFAULT_FILTERS.contentType);
  const [movies, setMovies] = useState(initialMovies);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(initialHasNextPage);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const firstFilterEffectRef = useRef(true);

  const requestPage = useCallback(async (nextPage: number, filters: CatalogueFilters, replace: boolean) => {
    if (!replace && loadingRef.current) return;
    if (replace) activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const requestId = ++requestIdRef.current;
    loadingRef.current = true;
    setLoading(true);
    setRequestError(false);
    if (replace) {
      setPage(1);
      setHasNext(false);
    }
    const params = new URLSearchParams({ page: String(nextPage), limit: String(PAGE_SIZE) });
    if (filters.query.trim()) params.set('q', filters.query.trim());
    if (filters.genre !== DEFAULT_FILTERS.genre) params.set('genre', filters.genre);
    if (filters.language !== DEFAULT_FILTERS.language) params.set('language', filters.language);
    if (filters.contentType !== DEFAULT_FILTERS.contentType) params.set('type', filters.contentType);
    try {
      const response = await fetch('/api/movies?' + params.toString(), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('catalogue request failed');
      const payload = await response.json() as { results?: PublicMovie[]; pagination?: { hasNextPage?: boolean } };
      if (requestId !== requestIdRef.current) return;
      const incoming = Array.isArray(payload.results) ? payload.results : [];
      setMovies((current) => {
        if (replace) return incoming;
        const bySlug = new Map(current.map((movie) => [movie.slug, movie]));
        for (const movie of incoming) bySlug.set(movie.slug, movie);
        return Array.from(bySlug.values());
      });
      setPage(nextPage);
      setHasNext(Boolean(payload.pagination?.hasNextPage));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId === requestIdRef.current) setRequestError(true);
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        setLoading(false);
        activeRequestRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const filters = { query, genre, language, contentType };
    const queryString = filtersQueryString(filters);
    window.history.replaceState({}, '', '/movies' + (queryString ? '?' + queryString : ''));
    if (firstFilterEffectRef.current) {
      firstFilterEffectRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void requestPage(1, filters, true);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [contentType, genre, language, query, requestPage]);

  useEffect(() => {
    const onPopState = () => {
      const next = filtersFromLocation();
      setQuery(next.query);
      setGenre(next.genre);
      setLanguage(next.language);
      setContentType(next.contentType);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const currentFilters = { query, genre, language, contentType };

  return (
    <main className="min-h-screen overflow-hidden bg-[#f2efe9] text-[#181916]">
      <header className="flixlyra-glass fixed inset-x-0 top-0 z-50 text-white">
        <div className="mx-auto flex h-[50px] max-w-[1480px] items-center px-4 sm:h-20 sm:px-8 lg:px-12">
          <a href="/" className="font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl">Flixlyra<span className="text-[#ef796d]">.</span></a>
          <nav className="mx-auto hidden items-center gap-8 text-sm font-medium text-white/70 lg:flex"><a href="/">Discover</a><a className="text-white" href="#movie-grid">Movies</a><a href="/content-policy">Content policy</a></nav>
          <a href="#discover" className="ml-auto hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/85 sm:flex"><Search size={15} /> Search</a>
          <span className="ml-auto lg:hidden" aria-hidden="true"><Menu /></span>
        </div>
      </header>

      <section id="discover" className="mx-auto max-w-[1480px] px-4 pb-8 pt-28 sm:px-8 sm:pb-12 sm:pt-36 lg:px-12">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><p className="section-kicker">The full collection</p><h1 className="mt-3 max-w-2xl font-serif text-5xl leading-[.95] tracking-[-.05em] sm:text-7xl">Find your next story.</h1></div><p className="max-w-md text-sm leading-6 text-black/55">Browse every published title. Results arrive in focused batches so the catalogue stays quick as it grows.</p></div>
        <div className="mt-8 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_210px_150px] sm:gap-3">
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-stone-300/80 bg-white/70 px-4 py-3 text-stone-900 transition-colors focus-within:border-stone-500 focus-within:bg-white"><Search size={18} className="shrink-0 text-stone-500" /><input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, director or cast" className="min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-stone-500" /></label>
          <FilterSelect label="Genre" value={genre} options={genres} onChange={setGenre} />
          <FilterSelect label="Subtitle" value={language} options={['All languages', ...allLanguages]} onChange={setLanguage} />
          <FilterSelect label="Type" value={contentType} options={['all', ...contentTypes]} onChange={setContentType} />
        </div>
      </section>

      <section id="movie-grid" className="mx-auto max-w-[1480px] px-4 pb-16 sm:px-8 sm:pb-20 lg:px-12">
        <div className="mb-4 flex items-end justify-between border-b border-black/15 pb-3 sm:mb-8 sm:pb-4"><p className="text-sm text-black/50">{movies.length} {movies.length === 1 ? 'film' : 'films'} shown</p><span className="hidden text-xs uppercase tracking-[.2em] text-black/40 md:block">Published catalogue</span></div>
        {movies.length ? <>
          <div className="grid grid-cols-3 gap-3 sm:gap-x-4 sm:gap-y-10 lg:grid-cols-5">{movies.map((movie) => <a key={movie.slug} href={contentHref(movie)} className="group text-stone-900"><div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-stone-200 shadow-[0_12px_30px_rgba(41,37,36,0.16)]"><img src={movie.poster} alt={movie.title + ' poster'} className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]" /><div className="absolute inset-0 bg-stone-900/0 transition group-hover:bg-stone-900/10" /><span className="absolute right-1.5 top-1.5 rounded-sm border border-stone-300/80 bg-white/85 px-1.5 py-1 text-[10px] font-bold text-stone-900 sm:right-3 sm:top-3 sm:px-2 sm:text-xs">? {movie.rating.toFixed(1)}</span><span className="absolute bottom-3 right-3 grid size-11 place-items-center rounded-full bg-[#de5d4f] text-white opacity-100 transition sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"><Play size={16} fill="currentColor" /></span></div><div className="mt-3 flex items-start gap-2 sm:mt-4 sm:gap-3"><div className="min-w-0"><h2 className="block min-h-5 w-full line-clamp-2 font-serif text-sm font-semibold leading-tight text-stone-900 sm:min-h-0 sm:text-xl">{movie.title}</h2><p className="mt-1.5 text-xs text-stone-600 sm:text-sm">{movie.year} ? {movie.runtime}</p></div></div></a>)}</div>
          {adsEnabled ? <aside aria-label="Advertisement" className="mt-14 grid min-h-28 place-items-center border border-dashed border-black/20 bg-white/20 px-6 text-center"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-black/35">Advertisement</p><p className="mt-2 text-sm text-black/45">Reserved for a verified cinema or entertainment partner</p></div></aside> : null}
        </> : <div className="border border-dashed border-black/20 py-16 text-center"><Sparkles className="mx-auto mb-3 text-black/25" /><p className="font-serif text-2xl">No published movies found</p><button type="button" onClick={() => { setQuery(''); setGenre(DEFAULT_FILTERS.genre); setLanguage(DEFAULT_FILTERS.language); setContentType(DEFAULT_FILTERS.contentType); }} className="mt-3 min-h-11 text-sm text-[#b43a2e] underline underline-offset-4">Clear all filters</button></div>}
        {hasNext ? <div className="mt-10 flex flex-col items-center gap-3"><button type="button" disabled={loading} onClick={() => void requestPage(page + 1, currentFilters, false)} className="inline-flex min-h-11 items-center justify-center rounded-full border border-black/20 px-6 py-3 text-sm font-semibold text-[#b43a2e] transition hover:border-black/40 disabled:cursor-wait disabled:opacity-60">{loading ? 'Loading...' : 'Load More'}</button></div> : null}
        {requestError ? <p className="mt-4 text-center text-sm text-[#b43a2e]">Catalogue loading failed. Try again.</p> : null}
      </section>

      <footer className="mx-auto flex max-w-[1480px] flex-col gap-4 border-t border-black/10 px-4 py-7 text-sm text-black/40 sm:flex-row sm:justify-between sm:px-8 lg:px-12"><span>? 2026 Flixlyra. Cinema in every language.</span><span className="flex flex-wrap gap-x-5 gap-y-3"><a href="/privacy">Privacy</a><a href="/content-policy">Content policy</a><a href="/advertise">Advertise</a></span></footer>
    </main>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <label className="relative flex min-h-12 min-w-0 items-center rounded-xl border border-stone-300/80 bg-stone-200/50 px-4 text-stone-900 transition-colors hover:border-stone-400 focus-within:border-stone-500 focus-within:bg-white/70"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none bg-transparent py-3 text-sm outline-none"><option value={options[0]}>{label}: {options[0]}</option>{options.slice(1).map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={15} className="pointer-events-none absolute right-4 text-stone-500" /></label>;
}
