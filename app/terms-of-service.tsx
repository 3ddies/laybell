import LegalScreen, { type LegalDoc } from '../components/LegalScreen';
import terms from '../lib/legal/terms.json';

// Official Laybell Terms of Service. Content lives in lib/legal/terms.json so it
// can be revised without touching UI code; LegalScreen renders it.
export default function TermsOfServiceScreen() {
  return <LegalScreen doc={terms as unknown as LegalDoc} />;
}
