import { notFound } from 'next/navigation';
import { Download, ArrowLeft } from 'lucide-react';
import { getPublishedMovie } from '../../../../db';
import { readyVideo } from '../../../../lib/r2-download';

export default async function MovieDownloadPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const movie = await getPublishedMovie((await params).slug);
  if (!movie) notFound();

  const sources = (movie.downloadSources ?? [])
    .filter((source) => /^(720p|1080p)$/i.test(source.quality || source.resolution || ''))
    .sort((a, b) => (a.quality.toLowerCase() === '1080p' ? -1 : 1) - (b.quality.toLowerCase() === '1080p' ? -1 : 1));
  const options = await Promise.all(sources.slice(0, 2).map(async (source) => ({
    quality: (source.quality || source.resolution).toLowerCase(),
    size: source.size || 'Size unavailable',
    ready: Boolean(await readyVideo(movie.slug, (source.quality || source.resolution).toLowerCase())),
  })));

  return (
    <main className="min-h-screen bg-[#171815] px-4 py-10 text-white sm:px-6 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <a href={`/movie/${movie.slug}`} className="inline-flex items-center gap-2 text-sm text-white/60 hover:text-white">
          <ArrowLeft size={16} /> Back to movie
        </a>
        <section className="mt-10 rounded-3xl border border-white/10 bg-white/[.04] p-6 shadow-2xl sm:p-8">
          <div className="flex items-center gap-5">
            <img src={movie.poster} alt={`${movie.title} poster`} className="h-28 w-20 rounded-xl object-cover" />
            <div>
              <p className="text-xs uppercase tracking-[.2em] text-white/45">Download</p>
              <h1 className="mt-2 font-serif text-3xl">{movie.title}</h1>
              <p className="mt-2 text-sm text-white/55">{movie.year} · Choose a quality</p>
            </div>
          </div>
          <div className="mt-8 grid gap-3">
            {options.map((option) => (
              option.ready ? (
                <a key={option.quality} href={`/api/download/resolve?slug=${encodeURIComponent(movie.slug)}&quality=${encodeURIComponent(option.quality)}`} className="flex min-h-14 items-center justify-between rounded-2xl bg-[#ef796d] px-5 py-4 font-semibold hover:bg-[#f58a7f] max-[380px]:px-3 max-[380px]:text-sm">
                  <span className="whitespace-nowrap">{option.quality} Direct Download <span className="ml-2 text-sm font-normal text-white/75">· {option.size}</span></span>
                  <Download size={18} />
                </a>
              ) : (
                <div key={option.quality} className="flex min-h-14 items-center justify-between rounded-2xl border border-white/10 px-5 py-4 text-white/40">
                  <span>{option.quality} unavailable <span className="ml-2 text-sm">· {option.size}</span></span>
                </div>
              )
            ))}
            {!options.length ? <p className="rounded-2xl border border-white/10 px-5 py-4 text-sm text-white/50">No verified download qualities are available yet.</p> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
