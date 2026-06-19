import LegalScreen, { type LegalDoc } from '../components/LegalScreen';
import advertising from '../lib/legal/advertising.json';

// Official Laybell Advertiser Terms & Advertising Policy. Content lives in
// lib/legal/advertising.json; LegalScreen renders it.
export default function AdvertiserTermsScreen() {
  return <LegalScreen doc={advertising as unknown as LegalDoc} />;
}
