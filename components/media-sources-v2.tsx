'use client';

import { useMemo, useState } from 'react';
import { Download, Flag, Play } from 'lucide-react';

type Stream = { label: string; url: string };
type DownloadSource = { label: string; quality: string; resolution: string; size: string; url: string };

export function MediaSourcesV2({ slug, title, streams, downloads }: { slug: string; title: string; streams: Stream[]; downloads: DownloadSource[] }) {
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const groups = useMemo(() => {
    const grouped = new Map<string, DownloadSource[]>();
    downloads.forEach((source) => grouped.set(source.resolution || 'Auto', [...(grouped.get(source.resolution || 'Auto') ?? []), source]));
    return [...grouped.entries()];
  }, [downloads]);
  async function report(kind: 'stream' | 'download', source: Stream | DownloadSource) {
    const reason = window.prompt('What is wrong with this source? (broken link, unsafe content, wrong file)');
    if (!reason) return;
    const response = await fetch(`/api/movies/${slug}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceKind: kind, sourceLabel: source.label, sourceUrl: source.url, reason }) });
    setNotice(response.ok ? 'Report received. Thank you.' : 'The report could not be submitted.');
  }
  return <>
    {streams.length > 0 && <section className="mx-auto max-w-[1380px] px-5 pb-10 sm:px-8 lg:px-12"><div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Streaming servers">{streams.map((source, index) => <button key={source.url} role="tab" aria-selected={active === index} onClick={() => setActive(index)} className={`rounded-full px-5 py-2.5 text-sm font-semibold ${active === index ? 'bg-[#ef796d] text-white' : 'border border-white/15 text-white/65 hover:border-white/35'}`}><Play size={14} className="mr-2 inline" />{source.label}</button>)}</div><div className="aspect-video overflow-hidden rounded-2xl border border-white/10 bg-black"><iframe key={streams[active]?.url} title={`${title} - ${streams[active]?.label}`} src={streams[active]?.url} className="h-full w-full" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation" /></div><button onClick={() => report('stream', streams[active])} className="mt-3 flex items-center gap-2 text-xs text-white/40 hover:text-white"><Flag size={13} /> Report this server</button></section>}
    {groups.length > 0 && <section className="mx-auto max-w-[1380px] px-5 pb-10 sm:px-8 lg:px-12"><p className="section-kicker text-[#ef796d]">Download options</p><div className="mt-5 space-y-4">{groups.map(([resolution, sources]) => <article key={resolution} className="rounded-2xl border border-white/10 bg-white/[.035] p-4 sm:p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-serif text-2xl">{resolution}</h3><p className="mt-1 text-xs uppercase tracking-[.16em] text-white/40">{sources.length} {sources.length === 1 ? 'mirror' : 'mirrors'}</p></div><span className="rounded-full border border-[#ef796d]/35 bg-[#ef796d]/10 px-3 py-1 text-xs font-semibold text-[#ffaaa0]">{resolution}</span></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{sources.map((source) => <div key={source.url} className="rounded-xl border border-white/10 bg-black/15 p-3"><div className="flex flex-wrap gap-2 text-xs text-white/60"><span className="rounded-full bg-white/10 px-2.5 py-1">{source.quality || 'Standard'}</span><span className="rounded-full bg-white/10 px-2.5 py-1">{source.size || 'Unknown'}</span></div><p className="mt-3 truncate text-sm font-semibold" title={source.label}>{source.label}</p><a href={source.url} download target="_blank" rel="noopener noreferrer" className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-[#ef796d] px-4 py-2.5 text-sm font-semibold text-white"><Download size={15} /> Download</a><button onClick={() => report('download', source)} className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-white/35 hover:text-white"><Flag size={12} /> Report mirror</button></div>)}</div></article>)}</div></section>}
    {notice && <p role="status" className="mx-auto max-w-[1380px] px-5 pb-6 text-sm text-white/55 sm:px-8 lg:px-12">{notice}</p>}
  </>;
}
