'use client';

import { MessageCircle, Send } from 'lucide-react';

export function ShareButtons({ title, path }: { title: string; path: string }) {
  const url = `https://flixlyra.com${path}`;
  const text = encodeURIComponent(`${title} — Flixlyra`);
  const encodedUrl = encodeURIComponent(url);
  return (
    <div className="flex items-center gap-2" aria-label="Share this title">
      <span className="mr-1 text-xs uppercase tracking-[.18em] text-white/35">
        Share
      </span>
      <a
        href={`https://wa.me/?text=${text}%20${encodedUrl}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Share on WhatsApp"
        className="grid size-10 place-items-center rounded-full border border-white/15 text-white/65 transition hover:border-emerald-400/70 hover:text-emerald-300"
      >
        <MessageCircle size={17} />
      </a>
      <a
        href={`https://t.me/share/url?url=${encodedUrl}&text=${text}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Share on Telegram"
        className="grid size-10 place-items-center rounded-full border border-white/15 text-white/65 transition hover:border-sky-400/70 hover:text-sky-300"
      >
        <Send size={16} />
      </a>
    </div>
  );
}
