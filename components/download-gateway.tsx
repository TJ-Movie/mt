import { Download, ShieldCheck } from 'lucide-react';

export type GatewaySource = {
  label: string;
  quality: string;
  resolution: string;
  size: string;
  url: string;
};

export function DownloadGateway({
  title,
  poster,
  backdrop: _backdrop,
  year,
  languages,
  episodeLabel,
  description: _description,
  rating: _rating,
  sources,
}: {
  title: string;
  poster: string;
  backdrop?: string;
  year: number;
  languages: readonly string[];
  episodeLabel?: string;
  description?: string;
  rating?: number;
  sources: GatewaySource[];
}) {
  const groups = [
    ...sources
      .reduce((map, source) => {
        const key = source.resolution || 'Auto';
        map.set(key, [...(map.get(key) ?? []), source]);
        return map;
      }, new Map<string, GatewaySource[]>())
      .entries(),
  ];
  return (
    <main className="min-h-screen bg-[#171815] px-4 py-6 text-white sm:px-8 sm:py-8 lg:px-12">
      <div className="mx-auto max-w-5xl">
        <a href="/" className="inline-flex min-h-11 items-center text-sm text-white/55 hover:text-white">
          Flixlyra.
        </a>
        <header className="mt-5 flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/[.045] p-4 sm:mt-8 sm:flex-row sm:items-center sm:gap-6 sm:rounded-3xl sm:p-7">
          <img
            src={poster}
            alt={`${title} poster`}
            className="h-40 w-28 rounded-xl object-cover shadow-xl sm:h-44"
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[.2em] text-[#ef796d]">
              Download gateway
            </p>
            <h1 className="mt-2 break-words font-serif text-3xl leading-tight sm:text-5xl">
              {title}
            </h1>
            {episodeLabel && (
              <p className="mt-2 text-white/60">{episodeLabel}</p>
            )}
            <p className="mt-3 text-sm text-white/50">
              {year} · {languages.slice(0, 4).join(' · ')}
            </p>
          </div>
        </header>
        {groups.length ? (
          <section className="mt-8 space-y-4">
            <h2 className="font-serif text-3xl">Choose quality</h2>
            {groups.map(([resolution, options]) => (
              <article
                key={resolution}
                className="rounded-2xl border border-white/10 bg-white/[.035] p-4 sm:p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-serif text-2xl">{resolution}</h3>
                  <span className="rounded-full bg-[#ef796d]/15 px-3 py-1 text-xs font-semibold text-[#ffaaa0]">
                    {options.length}{' '}
                    {options.length === 1 ? 'server' : 'servers'}
                  </span>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {options.map((source) => (
                    <div
                      key={source.url}
                      className="min-w-0 rounded-xl border border-white/10 bg-black/15 p-4"
                    >
                      <div className="flex flex-wrap gap-2 text-xs text-white/65">
                        <span className="rounded-full bg-white/10 px-2.5 py-1">
                          {source.quality || 'Standard'}
                        </span>
                        <span className="rounded-full bg-white/10 px-2.5 py-1">
                          {source.size || 'Unknown size'}
                        </span>
                        <span className="rounded-full bg-white/10 px-2.5 py-1">
                          {resolution}
                        </span>
                      </div>
                      <p
                        className="mt-3 truncate font-semibold"
                        title={source.label}
                      >
                        {source.label}
                      </p>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#ef796d] px-4 py-3 text-sm font-semibold"
                      >
                        <Download size={16} /> Download
                      </a>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </section>
        ) : (
          <section className="mt-8 rounded-2xl border border-dashed border-white/15 p-6 text-center sm:p-8">
            <p className="font-serif text-2xl">
              No approved download mirrors yet.
            </p>
            <p className="mt-2 text-sm text-white/50">
              This source is waiting for an authorised link.
            </p>
          </section>
        )}
        <p className="mt-8 flex items-start gap-2 text-xs leading-5 text-white/35">
          <ShieldCheck size={14} className="mt-0.5 shrink-0" /> Only links approved by the administrator are
          shown.
        </p>
      </div>
    </main>
  );
}
