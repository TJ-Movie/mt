import { notFound } from 'next/navigation';
import { getPublishedMovie } from '../../../../db';
import { approvedGatewaySources } from '../../../../lib/download-gateway';
import { DownloadGateway } from '../../../../components/download-gateway';

export default async function EpisodeDownloadPage({ params }: { params: Promise<{ post_id: string; episode_id: string }> }) {
  const { post_id, episode_id } = await params;
  const movie = await getPublishedMovie(post_id);
  const match = /^s?(\d+)[-e](\d+)$/i.exec(episode_id);
  const episode = movie?.episodes?.find((item) => match ? item.season === Number(match[1]) && item.episode === Number(match[2]) : item.episode === Number(episode_id));
  if (!movie || movie.contentType !== 'series' || !episode) notFound();
  const gateway = await approvedGatewaySources(movie, episode);
  if (!gateway) notFound();
  return <DownloadGateway {...gateway} sourceBasePath={`/download/${movie.slug}/${episode_id}/source`} />;
}
