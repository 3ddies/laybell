import LegalScreen, { type LegalDoc } from '../components/LegalScreen';
import privacy from '../lib/legal/privacy.json';

// Official Laybell Privacy Policy. Content lives in lib/legal/privacy.json so it
// can be revised without touching UI code; LegalScreen renders it.
export default function PrivacyPolicyScreen() {
  return <LegalScreen doc={privacy as unknown as LegalDoc} />;
}
