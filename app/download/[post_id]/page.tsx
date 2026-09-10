import { notFound, redirect } from 'next/navigation';
import { readyVideo } from '../../../lib/r2-download';
import { getPublishedMovie } from '../../../db';

export default async function DownloadPage({ params }: { params: Promise<{ post_id: string }> }) {
  const movie = await getPublishedMovie((await params).post_id);
  if (!movie) notFound();
  if (await readyVideo(movie.slug)) redirect(`/api/download/resolve?slug=${encodeURIComponent(movie.slug)}`);
  // Ingestion sources are inputs to the transfer job, never movie downloads.
  return <main className="min-h-screen bg-[#171815] px-6 py-24 text-center text-white">
    <h1 className="text-2xl">Movie download not available yet</h1>
    <p className="mt-4">The MP4 file is still being prepared or awaiting approval. Please try again later.</p>
    <a className="mt-6 inline-block underline" href={`/movie/${movie.slug}`}>Back to movie</a>
  </main>;
}
