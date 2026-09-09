import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '../../components/info-page';

export const metadata: Metadata = {
  title: 'Advertise — Flixlyra',
  description: 'Responsible advertising opportunities on Flixlyra.',
};

export default function AdvertisePage() {
  return (
    <InfoPage
      eyebrow="Partnerships"
      title="Advertising that respects the audience."
      intro="Flixlyra reserves a small number of clearly labelled placements for cinema, entertainment and language-learning partners."
    >
      <InfoSection title="Placement principles">
        <p>
          Advertisements must be visually separated from movie actions. They
          cannot imitate play or download buttons, trigger pop-ups, or redirect
          a visitor without a deliberate click.
        </p>
      </InfoSection>
      <InfoSection title="Suitable partners">
        <p>
          Cinemas, licensed streaming services, film festivals, subtitle tools
          and language-learning products are a natural fit. Promotions for
          unauthorised downloads, deceptive software or unsafe financial
          products are rejected.
        </p>
      </InfoSection>
      <InfoSection title="Measurement">
        <p>
          Use aggregated campaign reporting where possible. Avoid collecting
          sensitive visitor data, fingerprinting devices or selling browsing
          histories.
        </p>
      </InfoSection>
      <InfoSection title="Before launch">
        <p>
          An approved ad-network account or direct campaign details are still
          required. The current placements remain inactive until the provider,
          consent requirements and payment details are configured.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
