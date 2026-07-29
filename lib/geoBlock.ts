import { supabase } from './supabase';

// Regions Laybell does not operate in, and the machinery for asking which one a
// user is in.
//
// Mississippi's HB 1126 requires commercially reasonable age verification for
// every user and verifiable parental consent for minors, and — unlike almost
// every comparable state law — it has NO SIZE THRESHOLD. It applies at ten users
// the same way it applies at ten million. Third-party age assurance runs roughly
// $0.30–$2.00 per verification, which is unaffordable pre-revenue, and an ID
// check standing between a stranger and their first look at the app is the most
// reliable way to kill a young social product. Mississippi is about 1% of the US
// population. Declining to serve it is the cheaper mistake.
//
// EXPECTED TO BE TEMPORARY. Several states have passed comparable laws in
// varying states of injunction, and that status changes month to month. When
// Laybell can afford real age assurance this list should shrink to nothing.
//
// THE ENFORCEMENT IS NOT HERE. This module is the UX layer — asking the
// question, and explaining the answer. The control is in supabase/sql/geo_block.sql:
// restrictive RLS policies plus a SECURITY DEFINER `set_region` that stamps the
// block against the SERVER's list, so a client that simply declined to report
// the block cannot opt out of it. That split matters because `profiles` rows are
// created by a database trigger and by first-login repair as well as by the
// signup screen, and social sign-in never touches the signup screen at all.

/** Keep in sync with the `blocked_regions` table (the server is authoritative). */
export const BLOCKED_REGIONS: Record<string, string> = {
  MS: 'Mississippi',
};

export type UsRegion = { code: string; name: string };

export const US_REGIONS: UsRegion[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'GU', name: 'Guam' },
  { code: 'MP', name: 'Northern Mariana Islands' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
];

/**
 * True only for a region AFFIRMATIVELY KNOWN to be blocked.
 *
 * The asymmetry is deliberate and mirrors lib/minors.ts: an unknown region is
 * NOT blocked. Treating unknown as blocked would freeze every account created
 * before this shipped, and every account between signup and the onboarding
 * question.
 */
export function isBlockedRegion(code: string | null | undefined): boolean {
  if (!code) return false;
  return code.toUpperCase() in BLOCKED_REGIONS;
}

export function regionName(code: string | null | undefined): string {
  if (!code) return '';
  const up = code.toUpperCase();
  return US_REGIONS.find((r) => r.code === up)?.name ?? up;
}

/**
 * Record the user's region and return whether they are blocked.
 *
 * The RETURNED value comes from the server's list, not from BLOCKED_REGIONS
 * above — the constant here exists to name the region in the explanation, not to
 * decide the outcome. If the RPC is missing (pre-migration), this falls back to
 * the local list so the block still applies rather than failing open.
 */
export async function setRegion(code: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('set_region', { p_region_code: code });
    if (error) throw error;
    return data === true;
  } catch {
    // geo_block.sql hasn't been applied yet. Fail CLOSED — this is a legal
    // control, and the failure mode that matters is serving a state we've
    // decided not to serve.
    return isBlockedRegion(code);
  }
}
