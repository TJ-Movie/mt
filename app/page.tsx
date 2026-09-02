'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bell, Bookmark, Check, ChevronRight, Clapperboard, Menu, Play, Search, Star, X } from 'lucide-react';

const films = [
  { id: 1, title: 'Dune: Part Two', year: '2024', genre: 'Sci-Fi', score: '8.7', badge: 'සිංහල උපසිරැසි', image: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?auto=format&fit=crop&w=900&q=85' },
  { id: 2, title: 'The Last Kingdom', year: '2023', genre: 'Action', score: '8.4', badge: 'WEB-DL', image: 'https://images.unsplash.com/photo-1506461883276-594a12b11cf3?auto=format&fit=crop&w=900&q=85' },
  { id: 3, title: 'Night Shift', year: '2024', genre: 'Thriller', score: '7.9', badge: 'සිංහල උපසිරැසි', image: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?auto=format&fit=crop&w=900&q=85' },
  { id: 4, title: 'Beyond Earth', year: '2024', genre: 'Sci-Fi', score: '8.2', badge: '4K UHD', image: 'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=900&q=85' },
  { id: 5, title: 'Silent Horizon', year: '2023', genre: 'Drama', score: '7.7', badge: 'සිංහල උපසිරැසි', image: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85' },
  { id: 6, title: 'Red Line', year: '2024', genre: 'Action', score: '8.1', badge: 'WEB-DL', image: 'https://images.unsplash.com/photo-1517994112540-009c47ea476b?auto=format&fit=crop&w=900&q=85' },
];
const genres = ['All', 'Action', 'Sci-Fi', 'Thriller', 'Drama'];

export default function Home() {
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('All');
  const [saved, setSaved] = useState<number[]>([]);
  const [menu, setMenu] = useState(false);
  const filtered = useMemo(() => films.filter((film) => (genre === 'All' || film.genre === genre) && film.title.toLowerCase().includes(query.toLowerCase())), [query, genre]);
  const toggleSaved = (id: number) => setSaved((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'add_movie_to_watchlist',
      title: 'Add movie to watchlist',
      description: 'Add one Cinewave movie to the visible watchlist by its exact title.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const title = typeof input === 'object' && input && 'title' in input ? String((input as { title: unknown }).title) : '';
        const film = films.find((item) => item.title.toLowerCase() === title.toLowerCase());
        if (!film) throw new Error('Movie title not found.');
        setSaved((items) => items.includes(film.id) ? items : [...items, film.id]);
        return { title: film.title, status: 'saved' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, []);

  return <main className="min-h-screen bg-[#07080b] text-white">
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-[#07080b]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-20 max-w-[1440px] items-center gap-8 px-5 sm:px-8 lg:px-12">
        <a href="#top" className="flex shrink-0 items-center gap-2.5" aria-label="Cinewave home"><span className="grid size-10 place-items-center rounded-xl bg-[#e8ff47] text-black shadow-[0_0_30px_rgba(232,255,71,.18)]"><Clapperboard size={21}/></span><span className="text-xl font-black tracking-[-.04em]">CINE<span className="text-[#e8ff47]">WAVE</span></span></a>
        <nav className="hidden items-center gap-7 text-sm font-medium text-zinc-400 lg:flex"><a className="text-white" href="#movies">Home</a><a className="hover:text-white" href="#movies">Movies</a><a className="hover:text-white" href="#series">TV Series</a><a className="hover:text-white" href="#genres">Genres</a></nav>
        <label className="ml-auto hidden max-w-sm flex-1 items-center gap-3 rounded-full border border-white/10 bg-white/[.06] px-4 py-2.5 md:flex focus-within:border-[#e8ff47]/50"><Search size={18} className="text-zinc-500"/><input value={query} onChange={(e) => setQuery(e.target.value)} className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600" placeholder="Search movies, series..."/></label>
        <button aria-label="Notifications" className="hidden size-10 place-items-center rounded-full border border-white/10 text-zinc-400 hover:text-white sm:grid"><Bell size={18}/></button>
        <button onClick={() => setMenu(!menu)} aria-label="Toggle menu" className="ml-auto grid size-10 place-items-center rounded-full border border-white/10 lg:hidden">{menu ? <X size={20}/> : <Menu size={20}/>}</button>
      </div>
      {menu && <div className="border-t border-white/10 bg-[#0b0d11] px-5 py-5 lg:hidden"><nav className="grid gap-4 text-sm"><a href="#movies">Home</a><a href="#movies">Movies</a><a href="#series">TV Series</a><a href="#genres">Genres</a></nav></div>}
    </header>

    <section id="top" className="relative min-h-[720px] overflow-hidden pt-20">
      <img src="https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=2000&q=90" alt="Vast golden desert beneath a dramatic night sky" className="absolute inset-0 h-full w-full object-cover opacity-65"/>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,#07080b_0%,rgba(7,8,11,.88)_35%,rgba(7,8,11,.18)_70%),linear-gradient(0deg,#07080b_0%,transparent_45%)]"/>
      <div className="relative mx-auto flex min-h-[640px] max-w-[1440px] items-end px-5 pb-24 sm:px-8 lg:items-center lg:px-12 lg:pb-0"><div className="max-w-2xl pt-16">
        <div className="mb-5 flex items-center gap-3 text-xs font-bold uppercase tracking-[.16em]"><span className="rounded-full bg-[#e8ff47] px-3 py-1.5 text-black">Featured</span><span className="text-zinc-300">Now streaming</span></div>
        <p className="mb-1 text-lg font-bold tracking-[.25em] text-[#e8ff47]">A NEW ODYSSEY</p>
        <h1 className="max-w-xl text-6xl font-black uppercase leading-[.88] tracking-[-.065em] sm:text-7xl lg:text-[6.6rem]">Sands of<br/><span className="text-transparent [-webkit-text-stroke:1px_rgba(255,255,255,.7)]">Tomorrow</span></h1>
        <div className="mt-6 flex flex-wrap items-center gap-4 text-sm text-zinc-300"><span>2024</span><span className="rounded border border-white/30 px-2 py-0.5 text-xs">U/A 13+</span><span>2h 36m</span><span className="flex items-center gap-1.5"><Star size={15} className="fill-[#e8ff47] text-[#e8ff47]"/> 8.8</span></div>
        <p className="mt-5 max-w-xl text-base leading-7 text-zinc-300">A lone cartographer crosses a shifting desert to uncover a signal from humanity’s forgotten future.</p>
        <div className="mt-8 flex flex-wrap gap-3"><button className="flex items-center gap-2 rounded-full bg-[#e8ff47] px-6 py-3.5 text-sm font-bold text-black transition hover:scale-[1.03]"><Play size={18} fill="currentColor"/> Watch trailer</button><button onClick={() => toggleSaved(0)} className="flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-6 py-3.5 text-sm font-semibold backdrop-blur hover:bg-white/15">{saved.includes(0) ? <Check size={18}/> : <Bookmark size={18}/>} {saved.includes(0) ? 'Saved' : 'My list'}</button></div>
      </div></div>
    </section>

    <section id="movies" className="mx-auto max-w-[1440px] px-5 pb-24 sm:px-8 lg:px-12">
      <div className="mb-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between"><div><p className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-[#e8ff47]">Fresh this week</p><h2 className="text-3xl font-bold tracking-[-.04em] sm:text-4xl">Latest releases</h2></div><label className="flex items-center gap-3 rounded-full border border-white/10 bg-white/[.04] px-4 py-3 md:hidden"><Search size={17} className="text-zinc-500"/><input value={query} onChange={(e) => setQuery(e.target.value)} className="w-full bg-transparent text-sm outline-none" placeholder="Search titles..."/></label><div id="genres" className="flex gap-2 overflow-x-auto pb-1">{genres.map((item) => <button key={item} onClick={() => setGenre(item)} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm transition ${genre === item ? 'bg-white text-black' : 'border border-white/10 text-zinc-400 hover:text-white'}`}>{item}</button>)}</div></div>
      {filtered.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-9 sm:grid-cols-3 lg:grid-cols-6">{filtered.map((film, index) => <article key={film.id} className="group min-w-0"><div className="relative aspect-[2/3] overflow-hidden rounded-2xl bg-zinc-900"><img src={film.image} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105 group-hover:opacity-75"/><div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/90 to-transparent"/><span className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-[10px] font-bold backdrop-blur">{film.badge}</span><button onClick={() => toggleSaved(film.id)} aria-label={`Save ${film.title}`} className="absolute right-3 top-3 grid size-9 place-items-center rounded-full bg-black/60 backdrop-blur hover:bg-[#e8ff47] hover:text-black">{saved.includes(film.id) ? <Check size={16}/> : <Bookmark size={16}/>}</button><button aria-label={`Play ${film.title}`} className="absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-[#e8ff47] text-black opacity-0 transition group-hover:scale-100 group-hover:opacity-100"><Play size={18} fill="currentColor"/></button><span className="absolute bottom-3 left-3 text-xs font-semibold text-white/70">0{index + 1}</span></div><h3 className="mt-4 truncate font-bold">{film.title}</h3><div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-500"><span>{film.year}</span><span>•</span><span>{film.genre}</span><span className="ml-auto flex items-center gap-1 text-zinc-300"><Star size={11} className="fill-[#e8ff47] text-[#e8ff47]"/>{film.score}</span></div></article>)}</div> : <div className="rounded-2xl border border-dashed border-white/15 py-16 text-center text-zinc-500">No titles match your search.</div>}
    </section>

    <section id="series" className="border-y border-white/10 bg-[#0d0f14]"><div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-center lg:px-12"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#e8ff47]">Weekend collection</p><h2 className="mt-3 text-3xl font-bold tracking-[-.04em] sm:text-5xl">Stories worth staying up for.</h2><p className="mt-4 max-w-2xl leading-7 text-zinc-400">Discover hand-picked cinema with crisp quality, clean Sinhala subtitles, and new additions every week.</p></div><a href="#movies" className="flex items-center gap-2 text-sm font-bold text-[#e8ff47]">Explore all titles <ChevronRight size={17}/></a></div></section>
    <footer className="mx-auto flex max-w-[1440px] flex-col gap-4 px-5 py-10 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12"><span>© 2026 Cinewave. A cinema discovery concept.</span><div className="flex gap-5"><a href="#">Privacy</a><a href="#">Help</a><a href="#">Terms</a></div></footer>
  </main>;
}
