'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Menu, Play, Search, Sparkles, Star, X } from 'lucide-react';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [quickResults, setQuickResults] = useState<PublicMovie[]>([]);
  const [quickLoading, setQuickLoading] = useState(false);
  const [quickError, setQuickError] = useState(false);
  const quickAbortRef = useRef<AbortController | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    quickAbortRef.current?.abort();
    const trimmed = quickQuery.trim();
    if (!searchOpen || trimmed.length < 2) return;
    const controller = new AbortController();
    quickAbortRef.current = controller;
    const timer = window.setTimeout(async () => {
      setQuickLoading(true);
      try {
        const params = new URLSearchParams({ q: trimmed, page: '1', limit: '6' });
        const response = await fetch('/api/movies?' + params.toString(), { signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (!response.ok) throw new Error('quick search failed');
        const payload = await response.json() as { results?: PublicMovie[] };
        if (!controller.signal.aborted) setQuickResults(Array.isArray(payload.results) ? payload.results.slice(0, 6) : []);
      } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setQuickError(true); }
      finally { if (!controller.signal.aborted) setQuickLoading(false); }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [quickQuery, searchOpen]);

  const updateQuickQuery = (value: string) => { setQuickQuery(value); setQuickResults([]); setQuickError(false); setQuickLoading(false); };
  const openSearch = () => { setSearchOpen(true); window.requestAnimationFrame(() => quickInputRef.current?.focus()); };
  const closeSearch = () => { quickAbortRef.current?.abort(); setSearchOpen(false); setQuickQuery(''); setQuickResults([]); setQuickError(false); setQuickLoading(false); };
  const currentFilters = { query, genre, language, contentType };

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_18%_0%,rgba(239,121,109,.16),transparent_34%),radial-gradient(circle_at_88%_28%,rgba(28,43,72,.34),transparent_42%),linear-gradient(180deg,#101014_0%,#0a0a09_48%,#08090d_100%)] text-white">
      <header className="flixlyra-glass fixed inset-x-0 top-0 z-50 text-white">
        <div className="mx-auto flex h-[58px] max-w-[1480px] items-center px-4 sm:h-20 sm:px-8 lg:px-12">
                    {searchOpen ? <>
            <div className="hidden min-w-0 flex-1 items-center justify-end gap-2 sm:flex"><label className="flex h-11 w-[min(360px,42vw)] items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 text-white shadow-[0_8px_24px_rgba(0,0,0,.18)]"><Search size={17} className="shrink-0 text-white/60" aria-hidden="true" /><input ref={quickInputRef} value={quickQuery} onChange={(event) => updateQuickQuery(event.target.value)} placeholder="Search movies, actors..." className="min-w-0 flex-1 bg-transparent text-sm leading-normal outline-none placeholder:text-white/45" aria-label="Search movies, actors, or directors" />{quickQuery ? <button type="button" onClick={() => updateQuickQuery('')} className="grid size-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10" aria-label="Clear search"><X size={17} /></button> : null}</label><button type="button" onClick={closeSearch} className="grid size-11 shrink-0 place-items-center rounded-full text-white/75 hover:bg-white/10" aria-label="Close search"><X size={19} /></button></div>
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:hidden"><label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 text-white"><Search size={17} className="shrink-0 text-white/60" aria-hidden="true" /><input ref={quickInputRef} value={quickQuery} onChange={(event) => updateQuickQuery(event.target.value)} placeholder="Search movies, actors..." className="min-w-0 flex-1 bg-transparent text-sm leading-normal outline-none placeholder:text-white/45" aria-label="Search movies, actors, or directors" />{quickQuery ? <button type="button" onClick={() => updateQuickQuery('')} className="grid size-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10" aria-label="Clear search"><X size={17} /></button> : null}</label><button type="button" onClick={closeSearch} className="grid size-11 shrink-0 place-items-center rounded-full text-white/75 hover:bg-white/10" aria-label="Close search"><X size={19} /></button></div>
          </> : <>
            <a href="/" className="font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl">Flixlyra<span className="text-[#ef796d]">.</span></a>
            <nav className="ml-10 hidden items-center gap-8 text-sm font-medium text-white/70 lg:flex"><a href="/" className="transition-colors hover:text-[#ef796d]">Discover</a><a className="relative text-white after:absolute after:-bottom-2 after:left-0 after:h-0.5 after:w-full after:rounded-full after:bg-[#ef796d]" href="#movie-grid">Movies</a></nav>
            <button type="button" onClick={openSearch} className="ml-auto hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/85 transition hover:bg-white/10 sm:flex"><Search size={15} /> Search</button>
            <button type="button" onClick={openSearch} className="ml-auto grid size-10 place-items-center text-white transition hover:text-[#ef796d] lg:hidden" aria-label="Search movies"><Search size={18} /></button>
          </>}
          <button type="button" className="ml-1 grid size-11 place-items-center text-white lg:hidden" aria-label="Toggle navigation"><Menu /></button>
        </div>
        {searchOpen ? <div className="absolute left-3 right-3 top-full z-[60] max-h-[min(360px,calc(100vh-8rem))] overflow-y-auto rounded-b-2xl border border-t-0 border-white/15 bg-[#171713]/95 p-2 text-white shadow-[0_18px_42px_rgba(0,0,0,.35)] sm:left-auto sm:right-8 sm:top-[calc(100%+10px)] sm:w-[460px] sm:rounded-2xl sm:border sm:p-3 lg:right-12">
          {!quickQuery.trim() ? <p className="px-3 py-4 text-xs text-white/55">Search by movie title, director or cast member.</p> : null}
          {quickQuery.trim() && quickLoading ? <p className="px-3 py-4 text-xs text-white/55">Searching...</p> : null}
          {quickQuery.trim() && !quickLoading && quickError ? <p className="px-3 py-4 text-xs text-[#f1aaa2]">Search failed. Try again.</p> : null}
          {quickQuery.trim() && !quickLoading && !quickError && !quickResults.length ? <p className="px-3 py-4 text-xs text-white/55">No movies found.</p> : null}
          {quickResults.map((movie) => <a key={movie.slug} href={contentHref(movie)} onClick={closeSearch} className="group flex min-h-[68px] items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]"><img src={movie.poster} alt="" className="h-12 w-9 shrink-0 rounded-md object-cover" loading="lazy" decoding="async" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-white">{movie.title}</span><span className="mt-1 block truncate text-xs text-white/55">{movie.year} · {movie.genre}</span></span><span className="flex shrink-0 items-center gap-2 text-xs text-white/55"><span className="inline-flex items-center gap-1"><Star size={12} className="fill-current text-[#f4c95d]" />{movie.rating.toFixed(1)}</span><ChevronRight size={16} /></span></a>)}
          {quickQuery.trim() ? <a href={'/movies?q=' + encodeURIComponent(quickQuery.trim())} onClick={closeSearch} className="flex min-h-11 items-center justify-center gap-2 border-t border-white/10 px-3 py-3 text-sm font-semibold text-[#efaaa2]">View all results <ArrowRight size={15} /></a> : null}
        </div> : null}
      </header>

      <section id="discover" className="mx-auto max-w-[1480px] px-4 pb-8 pt-28 sm:px-8 sm:pb-12 sm:pt-36 lg:px-12">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between"><div><p className="section-kicker">The full collection</p><h1 className="mt-3 max-w-2xl font-serif text-5xl leading-[.95] tracking-[-.05em] sm:text-7xl">Find your next story.</h1></div></div>
        <div className="mt-8 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_210px_150px] sm:gap-3">
          <label className="flex min-h-12 items-center gap-3 rounded-xl border border-white/15 bg-white/[.06] px-4 py-3 text-white transition-colors focus-within:border-stone-500 focus-within:bg-white"><Search size={18} className="shrink-0 text-white/55" /><input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, director or cast" className="min-w-0 w-full bg-transparent text-sm outline-none placeholder:text-white/55" /></label>
          <FilterSelect label="Genre" value={genre} options={genres} onChange={setGenre} />
          <FilterSelect label="Subtitle" value={language} options={['All languages', ...allLanguages]} onChange={setLanguage} />
          <FilterSelect label="Type" value={contentType} options={['all', ...contentTypes]} onChange={setContentType} />
        </div>
      </section>

      <section id="movie-grid" className="mx-auto max-w-[1480px] px-4 pb-16 sm:px-8 sm:pb-20 lg:px-12">
        <div className="mb-4 flex items-end justify-between border-b border-white/15 pb-3 sm:mb-8 sm:pb-4"><p className="text-sm text-white/50">{movies.length} {movies.length === 1 ? 'film' : 'films'} shown</p><span className="hidden text-xs uppercase tracking-[.2em] text-white/40 md:block">Published catalogue</span></div>
        {movies.length ? <>
          <div className="grid grid-cols-3 gap-3 sm:gap-x-4 sm:gap-y-10 lg:grid-cols-5">{movies.map((movie) => <a key={movie.slug} href={contentHref(movie)} className="group text-white"><div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-white/[.08] shadow-[0_12px_30px_rgba(0,0,0,.32)]"><img src={movie.poster} alt={movie.title + ' poster'} className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]" /><div className="absolute inset-0 bg-stone-900/0 transition group-hover:bg-stone-900/10" /><span className="absolute right-1.5 top-1.5 rounded-sm border border-[#f4c95d]/45 bg-black/70 px-1.5 py-1 text-[10px] font-bold text-[#f4c95d] shadow-[0_4px_14px_rgba(0,0,0,.25)] sm:right-3 sm:top-3 sm:px-2 sm:text-xs">★ {movie.rating.toFixed(1)}</span><span className="absolute bottom-3 right-3 grid size-11 place-items-center rounded-full bg-[#de5d4f] text-white opacity-100 transition sm:translate-y-2 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"><Play size={16} fill="currentColor" /></span></div><div className="mt-3 flex items-start gap-2 sm:mt-4 sm:gap-3"><div className="min-w-0"><h2 className="block min-h-5 w-full line-clamp-2 font-serif text-sm font-semibold leading-tight text-white sm:min-h-0 sm:text-xl">{movie.title}</h2><p className="mt-1.5 text-xs text-white/55 sm:text-sm">{movie.year} · {movie.runtime}</p></div></div></a>)}</div>
          {adsEnabled ? <aside aria-label="Advertisement" className="mt-14 grid min-h-28 place-items-center border border-dashed border-black/20 bg-white/[.04] px-6 text-center"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-black/35">Advertisement</p><p className="mt-2 text-sm text-black/45">Reserved for a verified cinema or entertainment partner</p></div></aside> : null}
        </> : <div className="border border-dashed border-black/20 py-16 text-center"><Sparkles className="mx-auto mb-3 text-black/25" /><p className="font-serif text-2xl">No published movies found</p><button type="button" onClick={() => { setQuery(''); setGenre(DEFAULT_FILTERS.genre); setLanguage(DEFAULT_FILTERS.language); setContentType(DEFAULT_FILTERS.contentType); }} className="mt-3 min-h-11 text-sm text-[#ef796d] underline underline-offset-4">Clear all filters</button></div>}
        {hasNext ? <div className="mt-10 flex flex-col items-center gap-3"><button type="button" disabled={loading} onClick={() => void requestPage(page + 1, currentFilters, false)} className="inline-flex min-h-11 items-center justify-center rounded-full border border-black/20 px-6 py-3 text-sm font-semibold text-[#ef796d] transition hover:border-black/40 disabled:cursor-wait disabled:opacity-60">{loading ? 'Loading...' : 'Load More'}</button></div> : null}
        {requestError ? <p className="mt-4 text-center text-sm text-[#ef796d]">Catalogue loading failed. Try again.</p> : null}
      </section>

      <footer className="mx-auto flex max-w-[1480px] flex-col gap-4 border-t border-white/10 px-4 py-7 text-sm text-white/40 sm:flex-row sm:justify-between sm:px-8 lg:px-12"><span>© 2026 Flixlyra. Cinema in every language.</span><span className="flex flex-wrap gap-x-5 gap-y-3"><a href="/privacy">Privacy</a><a href="/content-policy">Content policy</a><a href="/advertise">Advertise</a></span></footer>
    </main>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  return <label className="relative flex min-h-12 min-w-0 items-center rounded-xl border border-white/15 bg-white/[.06] px-4 text-white transition-colors hover:border-stone-400 focus-within:border-stone-500 focus-within:bg-white/[.06]"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none bg-transparent py-3 text-sm outline-none"><option value={options[0]}>{label}: {options[0]}</option>{options.slice(1).map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={15} className="pointer-events-none absolute right-4 text-white/55" /></label>;
}
