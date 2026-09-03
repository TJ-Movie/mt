'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Globe2, Menu, Play, Search, Sparkles, Star, X } from 'lucide-react';
import type { PublicMovie } from '../lib/public-movie';
import { allLanguages, genres } from '../lib/movies';

export function MovieBrowser({ movies, adsEnabled }: { movies: PublicMovie[]; adsEnabled: boolean }) {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('All');
  const [language, setLanguage] = useState('All languages');
  const [menu, setMenu] = useState(false);
  const featured = movies.find((movie) => movie.featured) ?? movies[0];
  const filtered = useMemo(() => movies.filter((movie) => {
    const matchesQuery = `${movie.title} ${movie.director} ${movie.cast.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery && (genre === 'All' || movie.genre === genre) && (language === 'All languages' || movie.languages.includes(language));
  }), [movies, query, genre, language]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'filter_sublyra_movies', title: 'Filter Sublyra movies',
      description: 'Filter the visible movie catalogue by search text, genre, or subtitle language.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, genre: { type: 'string' }, language: { type: 'string' } }, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        if (!input || typeof input !== 'object') throw new Error('Filter input must be an object.');
        const values = input as { query?: unknown; genre?: unknown; language?: unknown };
        if (typeof values.query === 'string') setQuery(values.query.slice(0, 80));
        if (typeof values.genre === 'string') {
          if (!genres.includes(values.genre)) throw new Error('Unknown genre.');
          setGenre(values.genre);
        }
        if (typeof values.language === 'string') {
          if (values.language !== 'All languages' && !allLanguages.includes(values.language)) throw new Error('Unknown subtitle language.');
          setLanguage(values.language);
        }
        return { status: 'filtered', query: typeof values.query === 'string' ? values.query.slice(0, 80) : query, genre: typeof values.genre === 'string' ? values.genre : genre, language: typeof values.language === 'string' ? values.language : language };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [query, genre, language]);

  return <main className="min-h-screen overflow-hidden bg-[#f2efe9] text-[#181916]">
    <header className="fixed inset-x-0 top-0 z-50 border-b border-black/10 bg-[#f2efe9]/90 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-[1480px] items-center px-5 sm:px-8 lg:px-12">
        <a href="#top" className="font-serif text-2xl font-semibold tracking-[-.04em]">Sublyra<span className="text-[#b43a2e]">.</span></a>
        <nav className="mx-auto hidden items-center gap-8 text-sm font-medium text-black/60 lg:flex"><a className="text-black" href="#discover">Discover</a><a href="#collection">Movies</a><a href="#languages">Languages</a><a href="/content-policy">Content policy</a></nav>
        <a href="#discover" className="ml-auto hidden items-center gap-2 rounded-full border border-black/15 px-4 py-2 text-sm font-medium sm:flex"><Search size={15}/> Search</a>
        <button onClick={() => setMenu(!menu)} className="ml-auto grid size-10 place-items-center lg:hidden" aria-label="Toggle navigation">{menu ? <X/> : <Menu/>}</button>
      </div>
      {menu && <nav className="grid gap-4 border-t border-black/10 px-5 py-5 text-sm lg:hidden"><a href="#discover">Discover</a><a href="#collection">Movies</a><a href="#languages">Languages</a><a href="/content-policy">Content policy</a></nav>}
    </header>

    <section id="top" className="relative min-h-[760px] pt-20">
      <img src={featured.backdrop} alt="A quiet cinematic desert landscape" className="absolute inset-0 h-full w-full object-cover"/>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(12,13,11,.92)_0%,rgba(12,13,11,.68)_48%,rgba(12,13,11,.08)_78%),linear-gradient(0deg,rgba(12,13,11,.8)_0%,transparent_45%)]"/>
      <div className="relative mx-auto flex min-h-[680px] max-w-[1480px] items-end px-5 pb-16 text-white sm:px-8 lg:items-center lg:px-12 lg:pb-0">
        <div className="max-w-3xl pt-24"><div className="mb-7 flex items-center gap-3 text-xs font-semibold uppercase tracking-[.25em] text-white/65"><span className="h-px w-10 bg-[#de5d4f]"/> Featured film</div><h1 className="font-serif text-6xl leading-[.9] tracking-[-.055em] sm:text-8xl lg:text-[7.5rem]">{featured.title}</h1><p className="mt-5 font-serif text-xl italic text-white/65 sm:text-2xl">{featured.tagline}</p><div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-sm text-white/70"><span className="flex items-center gap-1.5"><Star size={14} className="fill-[#de5d4f] text-[#de5d4f]"/> {featured.rating}</span><span>{featured.year}</span><span>{featured.runtime}</span><span>{featured.genre}</span><span>{featured.languages.length} subtitle languages</span></div><p className="mt-6 max-w-xl text-base leading-7 text-white/65">{featured.description}</p><div className="mt-8 flex flex-wrap gap-3"><a href={`/movies/${featured.slug}`} className="inline-flex items-center gap-3 rounded-full bg-[#de5d4f] px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-[#c64d40]">Explore this film <ArrowRight size={17}/></a><a href="#discover" className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/15 px-6 py-3.5 text-sm font-semibold backdrop-blur"><Search size={16}/> Search all films</a></div></div>
      </div>
      <div className="absolute bottom-0 right-0 hidden w-[330px] border-l border-t border-white/15 bg-black/35 p-6 text-white backdrop-blur-md xl:block"><div className="flex items-center gap-3"><Globe2 className="text-[#ef796d]"/><div><p className="text-xs uppercase tracking-[.18em] text-white/45">Subtitle coverage</p><p className="mt-1 font-serif text-xl">One film. Many voices.</p></div></div></div>
    </section>

    <section id="discover" className="mx-auto max-w-[1480px] px-5 py-20 sm:px-8 lg:px-12">
      <div className="grid gap-10 lg:grid-cols-[.65fr_1.35fr] lg:items-end"><div><p className="section-kicker">Curated cinema</p><h2 className="mt-3 max-w-lg font-serif text-5xl leading-[.98] tracking-[-.04em] sm:text-6xl">Find your next story.</h2></div><div className="grid gap-3 sm:grid-cols-[1fr_180px_210px]"><label className="flex items-center gap-3 border-b border-black/25 py-3"><Search size={18} className="text-black/40"/><input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, director or cast" className="w-full bg-transparent text-sm outline-none placeholder:text-black/35"/></label><FilterSelect label="Genre" value={genre} options={genres} onChange={setGenre}/><FilterSelect label="Subtitle" value={language} options={['All languages', ...allLanguages]} onChange={setLanguage}/></div></div>
    </section>

    <section id="collection" className="mx-auto max-w-[1480px] px-5 pb-20 sm:px-8 lg:px-12">
      <div className="mb-8 flex items-end justify-between border-b border-black/15 pb-4"><p className="text-sm text-black/50">{filtered.length} {filtered.length === 1 ? 'film' : 'films'} found</p><span className="text-xs uppercase tracking-[.2em] text-black/40">Updated weekly</span></div>
      {filtered.length ? <><div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">{filtered.map((movie, index) => <a key={movie.slug} href={`/movies/${movie.slug}`} className="group"><div className="relative aspect-[2/3] overflow-hidden bg-[#d9d5ce]"><img src={movie.poster} alt={`${movie.title} poster`} className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]"/><div className="absolute inset-0 bg-black/0 transition group-hover:bg-black/15"/><span className="absolute left-3 top-3 bg-[#f2efe9]/90 px-2 py-1 text-xs font-semibold uppercase tracking-wider backdrop-blur">{movie.languages.length} subtitles</span><span className="absolute bottom-3 right-3 grid size-11 translate-y-2 place-items-center rounded-full bg-[#de5d4f] text-white opacity-0 transition group-hover:translate-y-0 group-hover:opacity-100"><Play size={16} fill="currentColor"/></span></div><div className="mt-4 flex items-start justify-between gap-3"><div><h3 className="font-serif text-xl leading-tight">{movie.title}</h3><p className="mt-1.5 text-sm text-black/45">{movie.year} · {movie.genre} · {movie.runtime}</p></div><span className="pt-1 text-xs font-semibold">{String(index + 1).padStart(2, '0')}</span></div></a>)}</div>{adsEnabled ? <aside aria-label="Advertisement" className="mt-14 grid min-h-28 place-items-center border border-dashed border-black/20 bg-white/20 px-6 text-center"><div><p className="text-xs font-semibold uppercase tracking-[.22em] text-black/35">Advertisement</p><p className="mt-2 text-sm text-black/45">Reserved for a verified cinema or entertainment partner</p></div></aside> : null}</> : <div className="border border-dashed border-black/20 py-16 text-center"><Sparkles className="mx-auto mb-3 text-black/25"/><p className="font-serif text-2xl">No film found</p><button onClick={() => { setQuery(''); setGenre('All'); setLanguage('All languages'); }} className="mt-3 text-sm text-[#b43a2e] underline underline-offset-4">Clear all filters</button></div>}
    </section>

    <section id="languages" className="bg-[#1a1b18] text-white"><div className="mx-auto grid max-w-[1480px] gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[.8fr_1.2fr] lg:px-12"><div><p className="section-kicker text-[#ef796d]">Built for the world</p><h2 className="mt-4 font-serif text-5xl leading-none tracking-[-.04em]">Every language opens another door.</h2></div><div className="flex flex-wrap content-start gap-2 pt-2">{allLanguages.map((item, index) => <button key={item} onClick={() => { setLanguage(item); location.hash = 'discover'; }} className="rounded-full border border-white/15 px-4 py-2.5 text-sm text-white/70 transition hover:border-[#ef796d] hover:text-white"><span className="mr-2 text-xs text-white/30">{String(index + 1).padStart(2, '0')}</span>{item}</button>)}</div></div></section>

    <section id="about" className="mx-auto max-w-[1480px] px-5 py-16 sm:px-8 lg:px-12"><div className="grid gap-8 border-b border-black/15 pb-14 md:grid-cols-3"><div><p className="font-serif text-3xl">Sublyra<span className="text-[#b43a2e]">.</span></p><p className="mt-3 max-w-xs text-base leading-7 text-black/50">One film. Many languages. A calm place to discover cinema across borders.</p></div><div><p className="text-xs font-semibold uppercase tracking-[.18em]">Responsible delivery</p><p className="mt-3 text-base leading-7 text-black/50">Watch and Telegram links are added only for content the publisher is authorised to distribute.</p></div><div><p className="text-xs font-semibold uppercase tracking-[.18em]">Advertise responsibly</p><p className="mt-3 text-base leading-7 text-black/50">Clear labels, no pop-ups, and no buttons designed to mislead visitors.</p><a href="/advertise" className="mt-3 inline-block text-sm font-semibold text-[#b43a2e] underline underline-offset-4">Partnership information</a></div></div><footer className="flex flex-col gap-3 py-7 text-sm text-black/40 sm:flex-row sm:justify-between"><span>© 2026 Sublyra. Cinema in every language.</span><span className="flex flex-wrap gap-x-5 gap-y-2"><a href="/privacy">Privacy</a><a href="/content-policy">Content policy</a><a href="/advertise">Advertise</a></span></footer></section>
  </main>;
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="relative border-b border-black/25 py-3"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="w-full appearance-none bg-transparent pr-7 text-sm outline-none">{options.map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={15} className="pointer-events-none absolute right-0 top-3.5 text-black/45"/></label>;
}
