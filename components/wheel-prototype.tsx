'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Film, Globe2, Home, LayoutGrid, Menu, Search, Star, X } from 'lucide-react';
import { allLanguages, genres } from '../lib/catalogue-options';
import type { WheelMovie } from '../lib/wheel-movie';
import { MovieCardGrid } from './movie-card-grid';

type WheelPrototypeProps = {
  movies: WheelMovie[];
  adsEnabled?: boolean;
  showFilters?: boolean;
  viewAllHref?: string;
};
type DesktopWheelAssignment = {
  movie: WheelMovie;
  movieIndex: number;
  slotIndex: number;
  active: boolean;
};

const ACTIVE_SLOT = 3;
const DESKTOP_WHEEL_SLOT_COUNT = 7;

function getWheelSlots(activeIndex: number, movies: readonly WheelMovie[]): DesktopWheelAssignment[] {
  if (!movies.length) return [];
  const visibleCount = Math.min(movies.length, DESKTOP_WHEEL_SLOT_COUNT);
  const firstDelta = -Math.floor(visibleCount / 2);
  return Array.from({ length: visibleCount }, (_, visibleIndex) => {
    const delta = firstDelta + visibleIndex;
    const slotIndex = ACTIVE_SLOT + delta;
    const movieIndex = (activeIndex + delta + movies.length) % movies.length;
    return {
      movie: movies[movieIndex],
      movieIndex,
      slotIndex,
      active: delta === 0,
    };
  });
}

function primaryGenre(movie: WheelMovie): string {
  return movie.genre.split(',')[0]?.trim() || 'Featured';
}

function movieHasGenre(movie: WheelMovie, genre: string): boolean {
  return movie.genre.split(',').some((item) => item.trim().toLowerCase() === genre.toLowerCase());
}

function contentHref(movie: WheelMovie): string {
  return '/' + (movie.contentType === 'series' ? 'series' : 'movie') + '/' + movie.slug;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

const HERO_CROSSFADE_MS = 320;

function CrossfadeBackdrop({ movie, onReady }: { movie: WheelMovie; onReady: (slug: string) => void }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(movie);
  const [incoming, setIncoming] = useState<WheelMovie | null>(null);
  const [incomingVisible, setIncomingVisible] = useState(false);

  useEffect(() => {
    if (movie.slug === shown.slug) return;
    let cancelled = false;
    let revealed = false;
    let frame: number | null = null;
    let fadeTimer: number | null = null;
    const preload = new window.Image();
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      const decoded = typeof preload.decode === 'function' ? preload.decode().catch(() => undefined) : Promise.resolve();
      void decoded.then(() => {
        if (cancelled) return;
        frame = window.requestAnimationFrame(() => {
          if (cancelled) return;
          setIncoming(movie);
          if (reduced) {
            onReady(movie.slug);
            setShown(movie);
            setIncoming(null);
            setIncomingVisible(false);
            return;
          }
          frame = window.requestAnimationFrame(() => {
            if (cancelled) return;
            onReady(movie.slug);
            setIncomingVisible(true);
            fadeTimer = window.setTimeout(() => {
              if (cancelled) return;
              setShown(movie);
              setIncoming(null);
              setIncomingVisible(false);
            }, HERO_CROSSFADE_MS);
          });
        });
      });
    };
    preload.onload = reveal;
    preload.onerror = () => undefined;
    preload.src = movie.backdrop;
    if (preload.complete && preload.naturalWidth > 0) reveal();
    return () => {
      cancelled = true;
      preload.onload = null;
      preload.onerror = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    };
  }, [movie, onReady, reduced, shown.slug]);

  return (
    <div className='absolute inset-0 overflow-hidden bg-[#11110f]' aria-hidden='true'>
      <img src={shown.backdrop} alt='' className='absolute inset-0 h-full w-full scale-[1.025] object-cover' decoding='async' fetchPriority='high' />
      {incoming ? (
        <img
          src={incoming.backdrop}
          alt=''
          className='absolute inset-0 h-full w-full scale-[1.025] object-cover transition-opacity motion-reduce:transition-none'
          style={{ opacity: incomingVisible ? 1 : 0, transitionDuration: HERO_CROSSFADE_MS + 'ms' }}
          decoding='async'
        />
      ) : null}
      <div className='absolute inset-0 bg-[linear-gradient(90deg,rgba(8,8,7,.98)_0%,rgba(8,8,7,.8)_31%,rgba(8,8,7,.36)_63%,rgba(8,8,7,.64)_100%)]' />
      <div className='absolute inset-0 bg-[linear-gradient(0deg,rgba(8,8,7,.96)_0%,rgba(8,8,7,.42)_34%,rgba(8,8,7,.2)_72%,rgba(8,8,7,.54)_100%)]' />
      <div className='absolute inset-0 bg-[radial-gradient(circle_at_78%_50%,rgba(239,121,109,.14),transparent_28%)]' />
    </div>
  );
}

function WheelItem({
  movie,
  active,
  slotIndex,
  index,
  onSelect,
}: {
  movie: WheelMovie;
  active: boolean;
  slotIndex: number;
  index: number;
  onSelect: (index: number) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      onSelect(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      onSelect(index - 1);
    }
  };

  return (
    <div
      data-wheel-index={index}
      className={'wheel-orbit-item wheel-slot-' + slotIndex + ' ' + (active ? 'wheel-slot-active text-white' : 'wheel-slot-inactive text-white/80 hover:text-white') + ' absolute z-20 flex items-center gap-3 text-left outline-none transition-[left,top,opacity,transform] duration-[480ms] ease-out motion-reduce:transition-none'}
    >
      <button
        type='button'
        aria-current={active ? 'true' : undefined}
        aria-pressed={active}
        aria-label={'Select ' + movie.title + ', ' + primaryGenre(movie)}
        onClick={() => onSelect(index)}
        onKeyDown={handleKeyDown}
        className='shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[#ef796d] focus-visible:ring-offset-2 focus-visible:ring-offset-black/40'
      >
        <span className={'relative block shrink-0 overflow-hidden rounded-full border-2 p-0.5 transition-[width,height,box-shadow,border-color] duration-500 motion-reduce:transition-none ' + (active
          ? 'size-20 border-[#ef796d] bg-[#ef796d]/20 shadow-[0_0_38px_rgba(239,121,109,.42)] sm:size-[5.5rem]'
          : 'size-14 border-white/35 bg-black/30 shadow-[0_8px_22px_rgba(0,0,0,.22)] sm:size-16 hover:border-white/70')}
        >
          <img src={movie.poster} alt='' className='h-full w-full rounded-full object-cover' loading={active ? 'eager' : 'lazy'} decoding='async' fetchPriority={active ? 'high' : 'auto'} />
          <span className={'absolute inset-0 rounded-full ring-1 ring-inset ' + (active ? 'ring-white/70' : 'ring-white/20')} />
        </span>
      </button>
      <span className={'min-w-0 max-w-[175px] drop-shadow-[0_2px_8px_rgba(0,0,0,.88)] ' + (active ? 'border-l-2 border-[#ef796d] pl-3' : 'pl-1')}>
        <span className={'block text-[10px] font-semibold uppercase tracking-[.18em] ' + (active ? 'text-[#efb0a8]' : 'text-white/55')}>{primaryGenre(movie)}</span>
        <a
          href={'/' + (movie.contentType === 'series' ? 'series' : 'movie') + '/' + movie.slug}
          onClick={(event) => event.stopPropagation()}
          className={'mt-1 block truncate font-serif text-base font-semibold leading-none transition-colors duration-200 hover:text-[#ef796d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d] sm:text-lg ' + (active ? 'text-white' : 'text-white/90')}
        >
          {movie.title}
        </a>
        <span className='mt-1 block text-[11px] text-white/55'>{movie.year} / {movie.rating.toFixed(1)}</span>
      </span>
    </div>
  );
}
type QuickSearchOverlayProps = {
  open: boolean;
  query: string;
  results: WheelMovie[];
  loading: boolean;
  error: boolean;
  onQueryChange: (query: string) => void;
  onClose: () => void;
};

function QuickSearchOverlay({
  open,
  query,
  results,
  loading,
  error,
  onQueryChange,
  onClose,
}: QuickSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [closing, setClosing] = useState(false);
  const trimmedQuery = query.trim();
  const viewAllHref = trimmedQuery ? '/movies?q=' + encodeURIComponent(trimmedQuery) : '/movies';

  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  }, [closing, onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, a, input, [tabindex]:not([tabindex=-1])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, requestClose]);

  return (
    <div className='search-overlay-motion hidden fixed inset-0 z-[80] bg-black/55 backdrop-blur-[3px] md:block md:bg-transparent md:backdrop-blur-0 md:p-0' role='presentation'>
      <button type='button' className='absolute inset-0 cursor-default' aria-label='Close search' onClick={requestClose} />
      <dialog
        ref={dialogRef}
        open
        aria-modal='true'
        aria-labelledby='quick-search-title'
        className={`search-glass-surface mobile-search-surface ${closing ? 'search-panel-closing' : 'search-panel-motion'} absolute inset-0 z-10 flex h-[100dvh] min-h-0 flex-col overflow-hidden border-0 p-0 text-white md:absolute md:inset-auto md:right-8 md:top-20 md:h-auto md:max-h-[min(520px,calc(100vh-6rem))] md:w-[min(480px,calc(100vw-2rem))] md:rounded-2xl md:border md:border-white/15 md:shadow-[0_24px_80px_rgba(0,0,0,.52)] lg:right-12 lg:top-[84px]`}
      >
        <div className='shrink-0 border-b border-white/10 px-4 md:px-8' style={{ paddingTop: 'max(.75rem, env(safe-area-inset-top))' }}>
          <div className='flex items-center gap-3 py-3'>
          <button type='button' onClick={requestClose} className='grid size-11 shrink-0 place-items-center rounded-full text-white/70 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#de5d4f] md:hidden' aria-label='Close search'>
            <ChevronLeft size={20} />
          </button>
          <div className='min-w-0 flex-1'>
            <p id='quick-search-title' className='text-[11px] font-semibold uppercase tracking-[.16em] text-[#e0796d]'>Search movies</p>
            <p className='mt-1 font-serif text-xl text-white md:hidden'>Find your next story.</p>
          </div>
          <button type='button' onClick={requestClose} className='grid size-11 shrink-0 place-items-center rounded-full text-white/70 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#de5d4f] md:grid' aria-label='Close search'>
            <X size={19} />
          </button>
          </div>
          <form onSubmit={(event) => event.preventDefault()} className='mb-4 flex items-center gap-3 rounded-2xl border border-white/15 bg-white/[.08] px-4 py-3 shadow-inner shadow-black/10 md:mb-5'>
              <Search size={19} className='shrink-0 text-white/55' aria-hidden='true' />
              <input
                ref={inputRef}
                type='search'
                value={query}
                maxLength={80}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder='Search movies, actors...'
                className='min-w-0 w-full bg-transparent py-1 text-base text-white outline-none placeholder:text-white/40'
                aria-label='Search movies, actors or directors'
              />
              {query ? (
                <button type='button' onClick={() => onQueryChange('')} className='grid size-11 shrink-0 place-items-center rounded-full text-white/55 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#de5d4f]' aria-label='Clear search'>
                  <X size={16} />
                </button>
              ) : null}
          </form>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6' aria-live='polite' aria-busy={loading}>
          {loading ? <p className='py-8 text-center text-sm text-white/55'>Searching...</p> : null}
          {!loading && error ? <p className='py-8 text-center text-sm text-[#efb0a8]'>Search is unavailable. Try again.</p> : null}
          {!loading && !error && !trimmedQuery ? <p className='mx-auto max-w-md py-6 text-center text-sm leading-5 text-white/70'>Search by movie title, director or cast member.</p> : null}
          {!loading && !error && trimmedQuery.length > 0 && trimmedQuery.length < 2 ? <p className='py-8 text-center text-sm text-white/55'>Type at least two characters.</p> : null}
          {!loading && !error && trimmedQuery.length >= 2 && !results.length ? <p className='py-8 text-center text-sm text-white/55'>No movies found.</p> : null}
          {!loading && !error && results.length ? (
            <div className='grid gap-2'>
              <div className='mb-2 flex items-center justify-between gap-3'>
                <p className='text-xs font-semibold uppercase tracking-[.2em] text-white/55'>Search results</p>
                <p className='text-xs text-white/45'>{results.length === 1 ? '1 result found' : results.length + ' results found'}</p>
              </div>
              {results.map((movie) => (
                <a key={movie.slug} href={contentHref(movie)} aria-label={movie.title} onClick={requestClose} className='group flex min-h-[68px] items-center gap-3 rounded-xl border border-transparent bg-white/[.045] p-2 transition hover:border-white/10 hover:bg-white/[.09] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#de5d4f]'>
                  <img src={movie.poster} alt='' className='size-12 shrink-0 rounded-lg object-cover' loading='lazy' decoding='async' />
                  <span className='min-w-0'>
                    <span className='block truncate font-serif text-[15px] font-semibold text-white'>{movie.title}</span>
                    <span className='mt-1 block truncate text-xs text-stone-500'>{movie.year} · {primaryGenre(movie)}</span>
                  </span>
                  <span className='ml-auto flex shrink-0 items-center gap-2 text-xs text-white/55'>
                    {movie.rating ? <span className='inline-flex items-center gap-1'><Star size={12} className='fill-current text-[#e0796d]' aria-hidden='true' />{movie.rating}</span> : null}
                    <ChevronRight size={16} aria-hidden='true' />
                  </span>
                </a>
              ))}
            </div>
          ) : null}
        </div>

        {trimmedQuery.length >= 2 ? (
          <div className='shrink-0 border-t border-white/10 px-4 py-4 md:px-8' style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            <a href={viewAllHref} onClick={requestClose} className='inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-[#de5d4f] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#c64d40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#de5d4f]'>
              View all results <ArrowRight size={16} />
            </a>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}

export function WheelPrototype({ movies, adsEnabled = false }: WheelPrototypeProps) {
  const boundedMovies = useMemo(() => movies.slice(0, 7), [movies]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menu, setMenu] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0);
  const [manualCooldown, setManualCooldown] = useState(false);
  const [manualInteractionTick, setManualInteractionTick] = useState(0);
  const [wheelHovered, setWheelHovered] = useState(false);
  const [wheelFocused, setWheelFocused] = useState(false);
  const [wheelDragging, setWheelDragging] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<WheelMovie[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const reducedMotion = useReducedMotion();
  const activeMovie = boundedMovies[activeIndex] ?? boundedMovies[0];
  const heroMovie = boundedMovies[heroIndex] ?? activeMovie;
  const activeContentHref = contentHref(heroMovie);
  const wheelRef = useRef<HTMLElement | null>(null);
  const pointerInteractionRef = useRef(false);
  const searchTriggerRef = useRef<HTMLElement | null>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestRef = useRef(0);
  const noteManualInteraction = useCallback(() => {
    setManualCooldown(true);
    setManualInteractionTick((tick) => tick + 1);
  }, []);
  const selectIndex = useCallback((index: number) => {
    if (boundedMovies.length) {
      noteManualInteraction();
      setActiveIndex((index + boundedMovies.length) % boundedMovies.length);
    }
  }, [boundedMovies.length, noteManualInteraction]);
  const advanceAutoplay = useCallback(() => {
    if (!boundedMovies.length) return;
    setActiveIndex((current) => (current + 1) % boundedMovies.length);
  }, [boundedMovies.length]);
  const commitHeroMovie = useCallback((slug: string) => {
    const nextIndex = boundedMovies.findIndex((movie) => movie.slug === slug);
    if (nextIndex >= 0) setHeroIndex(nextIndex);
  }, [boundedMovies]);
  const step = useCallback((direction: number) => selectIndex(activeIndex + direction), [activeIndex, selectIndex]);
  const pointerRef = useRef<{ x: number; y: number; lastX: number; dragging: boolean; id: number } | null>(null);
  const genreOptions = useMemo(() => genres.filter((genre) => genre !== 'All'), []);
  const genreCards = useMemo(() => {
    if (!boundedMovies.length) return [];
    return genreOptions.map((genre, index) => ({
      genre,
      movie: boundedMovies.find((movie) => movieHasGenre(movie, genre)) ?? boundedMovies[index % boundedMovies.length],
    }));
  }, [boundedMovies, genreOptions]);
  const mobileSelectorIndexes = useMemo(() => {
    if (!boundedMovies.length) return [];
    return [-2, -1, 0, 1, 2].map((offset) => (activeIndex + offset + boundedMovies.length) % boundedMovies.length);
  }, [activeIndex, boundedMovies.length]);

  const openSearch = useCallback((trigger?: HTMLElement) => {
    searchTriggerRef.current = trigger ?? null;
    setMenu(false);
    setSearchError(false);
    setSearchOpen(true);
  }, []);

  useEffect(() => {
    if (!searchOpen || window.innerWidth >= 768) return;
    const frame = window.requestAnimationFrame(() => mobileSearchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    searchAbortRef.current?.abort();
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);
    setSearchLoading(false);
    window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    searchAbortRef.current?.abort();
    const requestId = ++searchRequestRef.current;
    if (!searchOpen) return;
    const query = searchQuery.trim();
    if (query.length < 2) return;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, page: '1', limit: '6' });
        const response = await fetch('/api/movies?' + params.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('quick search failed');
        const payload = await response.json() as { results?: WheelMovie[] };
        if (requestId !== searchRequestRef.current) return;
        setSearchResults(Array.isArray(payload.results) ? payload.results.slice(0, 6) : []);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (requestId === searchRequestRef.current) {
          setSearchError(true);
          setSearchResults([]);
        }
      } finally {
        if (requestId === searchRequestRef.current) setSearchLoading(false);
      }
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchOpen, searchQuery]);

  const updateSearchQuery = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(false);
    } else {
      setSearchLoading(true);
      setSearchError(false);
    }
  }, []);

  useEffect(() => {
    const wheel = wheelRef.current;
    if (!wheel) return;
    const handlePointerEnter = () => setWheelHovered(true);
    const handlePointerLeave = () => setWheelHovered(false);
    const handleFocusIn = () => {
      if (!pointerInteractionRef.current) setWheelFocused(true);
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (!event.relatedTarget || !wheel.contains(event.relatedTarget as Node)) setWheelFocused(false);
    };
    const handleKeyDown = () => setWheelFocused(true);
    wheel.addEventListener('pointerenter', handlePointerEnter);
    wheel.addEventListener('pointerleave', handlePointerLeave);
    wheel.addEventListener('focusin', handleFocusIn);
    wheel.addEventListener('focusout', handleFocusOut);
    wheel.addEventListener('keydown', handleKeyDown);
    return () => {
      wheel.removeEventListener('pointerenter', handlePointerEnter);
      wheel.removeEventListener('pointerleave', handlePointerLeave);
      wheel.removeEventListener('focusin', handleFocusIn);
      wheel.removeEventListener('focusout', handleFocusOut);
      wheel.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    const wheel = wheelRef.current;
    if (!wheel) return;
    const handleWheelSelection = (event: MouseEvent) => {
      const element = event.target as Element | null;
      if (element?.closest('a')) return;
      if (element?.closest('button')) return;
      const target = element?.closest<HTMLElement>('.wheel-orbit-item');
      if (!target) return;
      const index = Number(target.dataset.wheelIndex);
      if (Number.isInteger(index)) selectIndex(index);
    };
    wheel.addEventListener('click', handleWheelSelection);
    return () => wheel.removeEventListener('click', handleWheelSelection);
  }, [selectIndex]);

  useEffect(() => {
    const updateVisibility = () => setPageHidden(document.hidden);
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    if (!boundedMovies.length || reducedMotion || pageHidden || wheelHovered || wheelFocused || wheelDragging) return;
    const timer = window.setTimeout(() => {
      if (manualCooldown) setManualCooldown(false);
      advanceAutoplay();
    }, manualCooldown ? 8000 : 7000);
    return () => window.clearTimeout(timer);
  }, [activeIndex, advanceAutoplay, boundedMovies.length, manualCooldown, manualInteractionTick, pageHidden, reducedMotion, wheelDragging, wheelFocused, wheelHovered]);

  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    pointerInteractionRef.current = true;
    setWheelFocused(false);
    noteManualInteraction();
    setWheelDragging(true);
    pointerRef.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, dragging: false, id: event.pointerId };
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.dragging) {
      if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy)) return;
      pointer.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const distance = event.clientX - pointer.lastX;
    if (Math.abs(distance) >= 42) {
      step(distance < 0 ? 1 : -1);
      pointer.lastX = event.clientX;
    }
  };

  const clearPointer = () => {
    pointerInteractionRef.current = false;
    pointerRef.current = null;
    setWheelDragging(false);
  };

  if (!activeMovie) return <main className='min-h-screen bg-[#f2efe9] p-10 text-stone-900'><div className='mx-auto max-w-3xl py-20 text-center'><p className='text-xs font-semibold uppercase tracking-[.2em] text-[#b64d42]'>Flixlyra</p><h1 className='mt-4 font-serif text-4xl'>Cinema is being prepared.</h1><p className='mt-4 text-sm text-stone-600'>Please check back soon for the next published stories.</p></div></main>;

  return (
    <main className='min-h-screen overflow-hidden bg-[#f2efe9] pb-[calc(4rem+env(safe-area-inset-bottom))] text-[#181916] sm:pb-0'>
      <header className='flixlyra-glass fixed inset-x-0 top-0 z-50 text-white'>
        <div className='mx-auto flex h-[58px] max-w-[1480px] items-center px-4 sm:h-20 sm:px-8 lg:px-12'>
          <a href='#top' className={'font-serif text-xl font-semibold tracking-[-.04em] sm:text-2xl ' + (searchOpen ? 'hidden sm:inline' : '')}>
            Flixlyra<span className='text-[#ef796d]'>.</span>
          </a>
          <nav className='ml-10 hidden items-center gap-8 text-sm font-medium text-white/70 lg:flex'>
            <a className='group relative text-white transition-colors hover:text-[#ef796d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]' href='#discover'>Discover<span className='absolute -bottom-2 left-0 h-0.5 w-full rounded-full bg-[#ef796d]' aria-hidden='true' /></a>
            <a className='transition-colors hover:text-[#ef796d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]' href='#movie-grid'>Movies</a>
          </nav>
          <button type='button' onClick={(event) => openSearch(event.currentTarget)} className='ml-auto hidden items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/85 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d] sm:flex'>
            <Search size={15} /> Search
          </button>
          {searchOpen ? (
            <div className='flex min-w-0 flex-1 items-center gap-2 sm:hidden'>
              <label className='flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-white/20 bg-black/35 px-3 text-white shadow-[0_8px_24px_rgba(0,0,0,.18)]'>
                <Search size={17} className='shrink-0 text-white/60' aria-hidden='true' />
                <input ref={mobileSearchInputRef} value={searchQuery} onChange={(event) => updateSearchQuery(event.target.value)} placeholder='Search movies, actors...' className='min-w-0 flex-1 bg-transparent text-sm leading-normal outline-none placeholder:text-white/45' aria-label='Search movies, actors, or directors' />
                {searchQuery ? <button type='button' onClick={() => updateSearchQuery('')} className='grid size-8 shrink-0 place-items-center rounded-full text-white/65 hover:bg-white/10 hover:text-white' aria-label='Clear search'><X size={17} /></button> : null}
              </label>
              <button type='button' onClick={closeSearch} className='grid size-11 shrink-0 place-items-center rounded-full text-white/75 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]' aria-label='Close search'><X size={19} /></button>
            </div>
          ) : (
            <button type='button' onClick={(event) => openSearch(event.currentTarget)} className='ml-auto grid size-10 place-items-center text-white transition hover:text-[#ef796d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d] sm:hidden' aria-label='Search movies'><Search size={18} /></button>
          )}
          <button type='button' onClick={() => setMenu(!menu)} className={'ml-1 grid size-11 place-items-center text-white lg:hidden ' + (searchOpen ? 'hidden sm:grid' : '')} aria-label='Toggle navigation' aria-expanded={menu} aria-controls='wheel-navigation'>
            {menu ? <X /> : <Menu />}
          </button>
        </div>
        {searchOpen ? (
          <div className='absolute left-3 right-3 top-full z-[60] overflow-hidden rounded-b-2xl border border-t-0 border-white/15 bg-[#171713]/95 text-white shadow-[0_18px_42px_rgba(0,0,0,.35)] sm:hidden'>
            <div className='max-h-[min(360px,calc(100vh-8rem))] overflow-y-auto p-2'>
              {!searchQuery.trim() ? <p className='px-3 py-4 text-xs text-white/55'>Search by movie title, director or cast member.</p> : null}
              {searchQuery.trim() && searchLoading ? <p className='px-3 py-4 text-xs text-white/55'>Searching...</p> : null}
              {searchQuery.trim() && !searchLoading && searchError ? <p className='px-3 py-4 text-xs text-[#f1aaa2]'>Search failed. Try again.</p> : null}
              {searchQuery.trim() && !searchLoading && !searchError && !searchResults.length ? <p className='px-3 py-4 text-xs text-white/55'>No movies found.</p> : null}
              {searchResults.map((movie) => (
                <a key={movie.slug} href={contentHref(movie)} onClick={closeSearch} className='flex min-h-[68px] items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>
                  <img src={movie.poster} alt='' className='h-12 w-9 shrink-0 rounded-md object-cover' loading='lazy' decoding='async' />
                  <span className='min-w-0 flex-1'><span className='block truncate text-sm font-semibold'>{movie.title}</span><span className='mt-1 block truncate text-xs text-white/55'>{movie.year} � {primaryGenre(movie)}</span></span>
                  <span className='flex shrink-0 items-center gap-2 text-xs text-white/55'>{movie.rating ? <span className='inline-flex items-center gap-1'><Star size={12} className='fill-current text-[#e0796d]' aria-hidden='true' />{movie.rating}</span> : null}<ChevronRight size={16} aria-hidden='true' /></span>
                </a>
              ))}
            </div>
            {searchQuery.trim() ? <a href={'/movies?q=' + encodeURIComponent(searchQuery.trim())} onClick={closeSearch} className='flex min-h-11 items-center justify-center gap-2 border-t border-white/10 px-3 py-3 text-sm font-semibold text-[#efaaa2]'>View all results <ArrowRight size={15} /></a> : null}
          </div>
        ) : null}
        {menu ? (
          <nav id='wheel-navigation' className='grid gap-1 border-t border-white/10 px-4 py-3 text-sm text-white/80 sm:px-8 lg:hidden'>
            <a className='rounded-lg px-2 py-3' href='#discover' onClick={() => setMenu(false)}>Discover</a>
            <a className='rounded-lg px-2 py-3' href='#movie-grid' onClick={() => setMenu(false)}>Movies</a>
            <button type='button' className='rounded-lg px-2 py-3 text-left' onClick={(event) => openSearch(event.currentTarget)}>Search movies</button>
            <a className='rounded-lg px-2 py-3' href='/movies' onClick={() => setMenu(false)}>Full catalogue &amp; filters</a>
            <a className='rounded-lg px-2 py-3' href='/content-policy' onClick={() => setMenu(false)}>Content policy</a>
          </nav>
        ) : null}
      </header>

      <section id='top' className='relative min-h-[clamp(540px,68svh,640px)] overflow-hidden bg-[#0a0a09] pt-[58px] text-white sm:min-h-[720px] sm:pt-20 lg:min-h-[760px]'>
        <CrossfadeBackdrop movie={activeMovie} onReady={commitHeroMovie} />
        <div className='relative z-20 mx-auto flex min-h-[clamp(500px,calc(68svh-58px),582px)] max-w-[1480px] items-start px-5 pb-24 pt-20 sm:min-h-[640px] sm:px-8 sm:pb-16 sm:pt-32 lg:min-h-[680px] lg:items-center lg:px-12 lg:pb-0 lg:pt-20'>
          <div className='relative z-30 max-w-[680px] lg:w-[54%]'>
            <div className='mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-[.25em] text-white/70 sm:mb-6'>
              <span className='h-px w-10 bg-[#ef796d]' /> Featured
            </div>
            <a href={activeContentHref} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} className='group inline-block max-w-full cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d] focus-visible:outline-offset-4' aria-label={'Open ' + heroMovie.title}>
              <h1 className='max-w-3xl font-serif text-6xl leading-[.88] tracking-[-.06em] drop-shadow-md transition-colors group-hover:text-[#f3aaa2] sm:text-8xl lg:text-[7rem]'>{heroMovie.title}</h1>
            </a>
            <p className='mt-4 max-w-xl font-serif text-xl italic leading-7 text-white/70 sm:text-2xl'>{heroMovie.tagline}</p>
            <div className='mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-white/75'>
              <span className='inline-flex items-center gap-1.5'><Star size={15} className='fill-[#ef796d] text-[#ef796d]' /> {heroMovie.rating.toFixed(1)}</span>
              <span>{heroMovie.year}</span>
              <span>{heroMovie.runtime}</span>
              <span>{heroMovie.genre}</span>
            </div>
            <p className='mt-5 line-clamp-2 max-w-xl text-sm leading-6 text-white/68 sm:mt-6 sm:line-clamp-none sm:text-base sm:leading-7'>{heroMovie.description}</p>
            <div className='mt-6 flex flex-wrap gap-3 sm:mt-7'>
              <a href={activeContentHref} className='inline-flex min-h-12 items-center gap-3 rounded-full bg-[#de5d4f] px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-[#c64d40]'>View movie <ArrowRight size={17} /></a>
              <a href='/movies' className='hidden min-h-12 items-center gap-3 rounded-full border border-white/25 bg-black/35 px-6 py-3.5 text-sm font-semibold text-white/90 transition hover:bg-black/60 sm:inline-flex'>Browse all films <ArrowRight size={17} /></a>
            </div>
          </div>

          <section
            aria-label='Featured movie wheel'
            className='pointer-events-auto absolute right-[-220px] top-1/2 z-40 hidden h-[800px] w-[800px] -translate-y-1/2 scale-[.78] sm:block lg:right-[-260px] lg:scale-[.86] xl:right-[-220px] xl:scale-[.94]'
            ref={wheelRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={clearPointer}
            onPointerCancel={clearPointer}
            style={{ touchAction: 'pan-y' }}
          >
            <div className='absolute left-[200px] top-[-10px] size-[800px] rounded-full border border-white/20' aria-hidden='true' />
            <div className='absolute inset-0 z-10'>
              {getWheelSlots(activeIndex, boundedMovies).map((slot) => {
                return <WheelItem key={slot.movie.slug} movie={slot.movie} active={slot.active} slotIndex={slot.slotIndex} index={slot.movieIndex} onSelect={selectIndex} />;
              })}
            </div>
            <div className='absolute bottom-[42px] left-[225px] z-30 flex items-center gap-2 text-xs uppercase tracking-[.2em] text-white/55'>
              <span className='size-2 rounded-full bg-[#ef796d]' /> {String(activeIndex + 1).padStart(2, '0')} / {String(boundedMovies.length).padStart(2, '0')}
            </div>
            <div className='absolute bottom-[38px] left-[420px] z-30 flex items-center gap-2'>
              <button type='button' onClick={() => step(-1)} aria-label='Previous featured movie' className='grid size-11 place-items-center rounded-full border border-white/20 bg-black/40 text-white/75 transition hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'><ChevronLeft size={19} /></button>
              <button type='button' onClick={() => step(1)} aria-label='Next featured movie' className='grid size-11 place-items-center rounded-full border border-white/20 bg-black/40 text-white/75 transition hover:bg-black/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'><ChevronRight size={19} /></button>
            </div>
          </section>

          <section
            aria-label='Featured movie selector'
            className='absolute inset-x-5 bottom-5 z-30 sm:hidden'
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={clearPointer}
            onPointerCancel={clearPointer}
            style={{ touchAction: 'pan-y' }}
          >
            <div className='mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[.2em] text-white/55'>
              <span>Featured films</span>
              <span aria-live='polite'>{String(activeIndex + 1).padStart(2, '0')} / {String(boundedMovies.length).padStart(2, '0')}</span>
            </div>
            <div className='flex items-end justify-center gap-2 overflow-visible px-1 pb-1'>
              {mobileSelectorIndexes.map((movieIndex) => {
                const movie = boundedMovies[movieIndex];
                if (!movie) return null;
                const active = movieIndex === activeIndex;
                return (
                  <button
                    key={movie.slug}
                    type='button'
                    aria-current={active ? 'true' : undefined}
                    aria-label={'Select ' + movie.title}
                    onClick={() => selectIndex(movieIndex)}
                    className={'relative grid shrink-0 place-items-center rounded-full outline-none transition-[width,height,transform,opacity] duration-500 motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-[#ef796d] focus-visible:ring-offset-2 focus-visible:ring-offset-black/40 ' + (active
                      ? 'size-[4.25rem] -translate-y-1 border-2 border-[#ef796d] bg-[#ef796d]/20 p-1 shadow-[0_0_28px_rgba(239,121,109,.4)]'
                      : 'size-[3.25rem] border border-white/35 bg-black/30 p-1 opacity-80')}
                  >
                    <img src={movie.poster} alt='' className='size-full rounded-full object-cover' loading={active ? 'eager' : 'lazy'} decoding='async' fetchPriority={active ? 'high' : 'auto'} />
                    <span className={'pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ' + (active ? 'ring-white/75' : 'ring-white/20')} />
                    <span className='sr-only'>{movie.title}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </section>

      <section id='discover' className='bg-[#f2efe9] px-5 pb-5 pt-8 sm:px-8 sm:pb-6 sm:pt-7 lg:px-12'>
        <div className='mx-auto max-w-[1480px]'>
          <div className='flex flex-wrap items-end justify-between gap-3 sm:gap-4'>
            <div>
              <p className='text-xs font-semibold uppercase tracking-[.25em] text-[#b64d42]'>Explore by genre</p>
              <h2 className='mt-2 max-w-2xl font-serif text-4xl leading-[.95] tracking-[-.05em] sm:text-5xl'>Find your next story.</h2>
            </div>
            <a href='/movies' className='inline-flex items-center gap-2 text-sm font-semibold text-[#8f392f] transition hover:text-[#181916] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#b64d42]'>Browse all genres <ArrowRight size={16} /></a>
          </div>
          <div className='no-scrollbar mt-4 flex snap-x gap-3 overflow-x-auto pb-2 sm:mt-4 sm:grid sm:grid-cols-5 sm:gap-4 sm:overflow-visible lg:grid-cols-5 xl:grid-cols-5'>
            {genreCards.map(({ genre, movie }) => (
              <a key={genre} href={'/movies?genre=' + encodeURIComponent(genre)} className='group relative min-w-[72px] snap-start text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#b64d42] sm:min-w-0'>
                <div className='relative mx-auto h-14 w-14 overflow-hidden rounded-full border border-black/10 bg-stone-200 shadow-[0_14px_28px_rgba(41,37,36,0.12)] sm:aspect-square sm:h-auto sm:w-full sm:max-w-[130px]'>
                  <img src={movie.poster} alt={genre + ' discovery artwork'} className='h-full w-full object-cover transition duration-700 group-hover:scale-[1.06]' loading='lazy' decoding='async' />
                   <div className='absolute inset-0 bg-gradient-to-t from-black/65 via-black/5 to-transparent' />
                 </div>
                 <span className='mt-2 block truncate text-center text-[10px] font-semibold text-stone-700 sm:text-[15px]'>{genre}</span>
              </a>
            ))}
            </div>
          </div>
      </section>

      <section id='collection' className='bg-[#f2efe9] px-5 pb-6 pt-7 sm:px-8 sm:pb-10 sm:pt-7 lg:px-12'>
        <div className='mx-auto max-w-[1480px]'>
          <div className='mb-5 flex flex-wrap items-end justify-between gap-4 sm:mb-8'>
            <div>
              <p className='text-xs font-semibold uppercase tracking-[.25em] text-[#b64d42]'>Featured collection</p>
              <h2 className='mt-2 font-serif text-4xl leading-none tracking-[-.05em] sm:text-6xl'>Keep exploring.</h2>
            </div>
            <a href='/movies' className='inline-flex items-center gap-2 text-sm font-semibold text-[#8f392f] transition hover:text-[#181916]'>View all films <ArrowRight size={16} /></a>
          </div>
          <div id='movie-grid'>
            <MovieCardGrid movies={movies} />
            {adsEnabled ? (
              <aside aria-label='Advertisement' className='mt-10 grid min-h-28 place-items-center border border-dashed border-black/20 bg-white/20 px-6 text-center'>
                <div>
                  <p className='text-xs font-semibold uppercase tracking-[.22em] text-black/35'>Advertisement</p>
                  <p className='mt-2 text-sm text-black/45'>Reserved for a verified cinema or entertainment partner</p>
                </div>
              </aside>
            ) : null}
          </div>
        </div>
      </section>

      <section id='languages' className='bg-[#1a1b18] text-white'>
        <div className='mx-auto grid max-w-[1480px] gap-8 px-5 py-10 sm:gap-10 sm:px-8 sm:py-14 lg:grid-cols-[.8fr_1.2fr] lg:px-12 lg:py-16'>
          <div>
            <p className='section-kicker text-[#ef796d]'>Built for the world</p>
            <h2 className='mt-3 max-w-lg font-serif text-3xl leading-[1.05] tracking-[-.04em] sm:text-4xl'>Every language opens another door.</h2>
          </div>
          <div className='no-scrollbar flex max-w-full flex-nowrap gap-2 overflow-x-auto pb-2 pt-1 lg:flex-wrap lg:content-start lg:overflow-visible'>
            {allLanguages.map((item, index) => (
              <a
                key={item}
                href={'/movies?language=' + encodeURIComponent(item)}
                className='inline-flex min-h-11 shrink-0 items-center rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/70 transition hover:border-[#ef796d] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'
              >
                <span className='mr-2 text-xs text-white/30'>{String(index + 1).padStart(2, '0')}</span>
                {item}
              </a>
            ))}
          </div>
        </div>
      </section>

      <footer id='about' className='bg-[#171713] px-5 py-12 text-white sm:px-8 sm:py-16 lg:px-12'>
        <div className='mx-auto flex max-w-[1480px] flex-col gap-10'>
          <div className='flex flex-col gap-7 sm:flex-row sm:items-end sm:justify-between'>
            <div>
              <a href='#top' className='font-serif text-3xl font-semibold tracking-[-.05em]'>Flixlyra<span className='text-[#ef796d]'>.</span></a>
              <p className='mt-3 max-w-xs font-serif text-xl text-white/75'>More than movies. A better way to feel.</p>
            </div>
            <div className='flex items-center gap-3 text-sm text-white/55'>
              <Globe2 size={18} className='text-[#ef796d]' />
              <span>10+ subtitle languages.</span>
            </div>
          </div>
          <div className='flex flex-col gap-4 border-t border-white/10 pt-5 text-sm text-white/45 sm:flex-row sm:items-center sm:justify-between'>
            <span>2026 Flixlyra. Cinema in every language.</span>
            <nav aria-label='Footer navigation' className='flex flex-wrap gap-x-5 gap-y-3'>
              <a href='/movies' className='transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>Movies</a>
              <a href='/privacy' className='transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>Privacy</a>
              <a href='/content-policy' className='transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>Content policy</a>
              <a href='/advertise' className='transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>Advertise</a>
            </nav>
          </div>
        </div>
      </footer>

      {searchOpen ? (
        <QuickSearchOverlay
          open={searchOpen}
          query={searchQuery}
          results={searchResults}
          loading={searchLoading}
          error={searchError}
          onQueryChange={updateSearchQuery}
          onClose={closeSearch}
        />
      ) : null}

      <nav aria-label='Mobile navigation' className='fixed inset-x-0 bottom-0 z-[90] border-t border-white/10 bg-[#171713]/95 text-white shadow-[0_-12px_30px_rgba(0,0,0,.18)] backdrop-blur-md sm:hidden' style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className='mx-auto grid h-16 max-w-md grid-cols-4'>
          <a href='#top' aria-current='page' className='relative flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold uppercase tracking-[.12em] text-[#ef796d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>
            <span className='absolute inset-x-5 top-0 h-0.5 rounded-full bg-[#ef796d]' />
            <Home size={18} aria-hidden='true' />
            <span>Home</span>
          </a>
          <a href='/movies' className='flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold uppercase tracking-[.12em] text-white/65 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>
            <Film size={18} aria-hidden='true' />
            <span>Movies</span>
          </a>
          <button type='button' onClick={(event) => openSearch(event.currentTarget)} aria-pressed={searchOpen} className={'relative flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold uppercase tracking-[.12em] transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d] ' + (searchOpen ? 'text-[#ef796d]' : 'text-white/65 hover:text-white')}>
            {searchOpen ? <span className='absolute inset-x-5 top-0 h-0.5 rounded-full bg-[#ef796d]' /> : null}
            <Search size={18} aria-hidden='true' />
            <span>Search</span>
          </button>
          <a href='#discover' className='flex min-h-11 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-semibold uppercase tracking-[.12em] text-white/65 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ef796d]'>
            <LayoutGrid size={18} aria-hidden='true' />
            <span>Genres</span>
          </a>
        </div>
      </nav>
    </main>
  );
}
