import { notFound, redirect } from 'next/navigation';
import { readyVideo } from '../../../lib/r2-download';
import { getPublishedMovie } from '../../../db';
import { approvedGatewaySources } from '../../../lib/download-gateway';
import { DownloadGateway } from '../../../components/download-gateway';

export default async function DownloadPage({ params }: { params: Promise<{ post_id: string }> }) {
  const movie = await getPublishedMovie((await params).post_id);
  if (!movie) notFound();
  if (await readyVideo(movie.slug)) redirect(`/api/download/resolve?slug=${encodeURIComponent(movie.slug)}`);
  const gateway = await approvedGatewaySources(movie);
  if (!gateway) notFound();
  return <DownloadGateway {...gateway} sourceBasePath={`/download/${movie.slug}/source`} />;
}
