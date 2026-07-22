import LegalScreen, { type LegalDoc } from '../components/LegalScreen';
import marketplace from '../lib/legal/marketplace.json';

// The Marketplace & Beat Licensing Terms — what Buy / Lease / Free actually
// grant, the exclusivity and refund rules, and the store guidelines. Linked
// from Settings → About, the shop's seller agreement, and listing pages.
export default function MarketplaceTermsScreen() {
  return <LegalScreen doc={marketplace as unknown as LegalDoc} />;
}
