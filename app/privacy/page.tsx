import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '../../components/info-page';

export const metadata: Metadata = {
  title: 'Privacy — Flixlyra',
  description:
    'How Flixlyra handles visitor data, advertising and external links.',
};

export default function PrivacyPage() {
  return (
    <InfoPage
      eyebrow="Trust centre"
      title="Privacy without the small-print maze."
      intro="Flixlyra is designed to collect as little visitor information as possible. This page explains the current site behaviour and what must change before any advertising service is activated."
    >
      <InfoSection title="What the site processes">
        <p>
          Search and filter choices are handled in your browser for the current
          visit. Flixlyra does not currently require a visitor account or collect
          payment information.
        </p>
      </InfoSection>
      <InfoSection title="External links">
        <p>
          Official watch and Telegram links pass through a protected gateway
          that accepts only approved HTTPS destinations. The destination service
          may apply its own privacy policy.
        </p>
      </InfoSection>
      <InfoSection title="Advertising">
        <p>
          Current advertisement areas are placeholders. Before an ad partner is
          activated, its name, cookie use and opt-out choices should be
          disclosed here. Misleading buttons, forced redirects and pop-up chains
          are not permitted.
        </p>
      </InfoSection>
      <InfoSection title="Security">
        <p>
          Flixlyra uses restrictive browser security policies and blocks
          unapproved outbound-link hosts. No security control can remove every
          risk; suspicious links should remain disabled until verified.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
