'use client';

import { Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';

function trailerEmbedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${url.pathname.slice(1).split('/')[0]}?autoplay=1`;
    if (host.endsWith('youtube.com')) {
      const id = url.searchParams.get('v') ?? url.pathname.match(/\/shorts\/([^/]+)/)?.[1] ?? url.pathname.match(/\/embed\/([^/]+)/)?.[1];
      return id ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1` : null;
    }
  } catch { return null; }
  return null;
}

export function TrailerModal({ url, title }: { url: string; title: string }) {
  const [open, setOpen] = useState(false);
  const embed = trailerEmbedUrl(url);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  return <>
    <button type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-full border border-white/20 px-6 py-3.5 text-sm font-semibold transition hover:border-[#ef796d] hover:bg-white/[.06]"><Play size={17} fill="currentColor"/> Watch trailer</button>
    {open ? <dialog open aria-modal="true" aria-label={`${title} trailer`} className="fixed inset-0 z-[100] m-0 h-full w-full max-w-none place-items-center border-0 bg-black/80 p-5 backdrop-blur-sm">
      <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-[#171815] shadow-2xl"><button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-full bg-black/60 text-white" aria-label="Close trailer"><X size={20}/></button>{embed ? <div className="aspect-video"><iframe title={`${title} trailer`} src={embed} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen className="h-full w-full"/></div> : <div className="grid min-h-48 place-items-center p-8 text-center"><div><p className="font-serif text-2xl">Trailer ready to watch</p><a href={url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex rounded-full bg-[#ef796d] px-5 py-3 text-sm font-semibold">Open on YouTube</a></div></div>}</div>
    </dialog> : null}
  </>;
}
