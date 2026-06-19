import LegalScreen, { type LegalDoc } from '../components/LegalScreen';
import community from '../lib/legal/community.json';

// Official Laybell Community Guidelines. Content lives in lib/legal/community.json
// so it can be revised without touching UI code; LegalScreen renders it.
export default function CommunityGuidelinesScreen() {
  return <LegalScreen doc={community as unknown as LegalDoc} />;
}
