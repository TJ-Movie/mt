import { notFound } from 'next/navigation';
import { getPublishedMovie } from '../../../db';
import { approvedGatewaySources } from '../../../lib/download-gateway';
import { DownloadGateway } from '../../../components/download-gateway';

export default async function DownloadPage({ params }: { params: Promise<{ post_id: string }> }) {
  const movie = await getPublishedMovie((await params).post_id);
  if (!movie) notFound();
  const gateway = await approvedGatewaySources(movie);
  if (!gateway) notFound();
  return <DownloadGateway {...gateway} />;
}
