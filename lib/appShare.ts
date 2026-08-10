import { Linking, Platform } from 'react-native';
import * as Contacts from 'expo-contacts';
import { supabase } from './supabase';
import { sha256Hex, normalizeEmail, normalizePhone } from './hash';
import { evaluateBadgesDebounced } from './badges';

// Inviting people to Laybell — the honest half of the App-sharing (Advocate) badge.
//
// The badge used to increment on any completed share sheet, so sending the link
// to yourself fifteen times earned Gold. Progress now counts DISTINCT PEOPLE:
// each invite is stored against a salted hash of the contact, keyed unique per
// user (see supabase/sql/app_share_invites.sql), so a repeat send moves nothing.
//
// PRIVACY: names stay on the device — only the hash of a normalized phone/email
// is ever sent, exactly as contact discovery already works (lib/hash.ts). The
// address book is read at the moment the screen opens and is never uploaded.

export type InviteContact = {
  /** expo-contacts id, or the hash when the platform gives no id. */
  id: string;
  name: string;
  /** Shown so two "Mum"s are tellable apart. Phone preferred over email. */
  label: string;
  /** The value we open the SMS/mail composer with. */
  target: string;
  isPhone: boolean;
  /** Salted hash of the normalized target — what the server stores. */
  hash: string;
  /** Already invited: ticked off permanently, and it can't be re-counted. */
  invited: boolean;
};

/** Contacts read per pass. Big address books are common; the list is virtualized. */
const MAX_CONTACTS = 2000;

export type InviteLoad = {
  /** 'denied' → the OS refused; 'ok' → we read the book, however small. */
  status: 'ok' | 'denied';
  contacts: InviteContact[];
  /**
   * Lifetime invites from the SERVER, not a count of ticked rows. The two can
   * differ — invite someone, then delete them from your phone — and the badge
   * follows the server, so the screen has to as well or it contradicts itself.
   */
  invitedTotal: number;
};

/**
 * The device address book, each entry paired with its hash and whether this user
 * has already invited them.
 *
 * Distinguishes "the OS said no" from "granted, but nothing usable in there" —
 * they need opposite things said to them, and an empty book is not an error.
 */
export async function loadInviteContacts(): Promise<InviteLoad> {
  const perm = await Contacts.requestPermissionsAsync().catch(() => null);
  if (!perm?.granted) return { status: 'denied', contacts: [], invitedTotal: 0 };

  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails, Contacts.Fields.Name],
  });

  // Who this user has already invited. A failure here must not silently un-tick
  // everyone (that would push duplicate sends), so it aborts the whole load.
  const { data: rows, error } = await supabase
    .from('app_share_invites').select('contact_hash');
  if (error) throw error;
  const already = new Set((rows ?? []).map((r: any) => r.contact_hash));
  const invitedTotal = already.size;

  const out: InviteContact[] = [];
  const seen = new Set<string>();

  for (const c of data ?? []) {
    if (out.length >= MAX_CONTACTS) break;
    // One entry per PERSON, not per number — inviting "Mum (mobile)" and
    // "Mum (home)" is one human, and the badge counts humans.
    const phone = normalizePhone(c.phoneNumbers?.[0]?.number);
    const email = phone ? null : normalizeEmail(c.emails?.[0]?.email);
    const target = phone ?? email;
    if (!target) continue;
    if (seen.has(target)) continue;
    seen.add(target);

    const hash = await sha256Hex(target);
    if (!hash) continue; // crypto unavailable — skip rather than send unhashable

    out.push({
      id: c.id ?? hash,
      name: (c.name || '').trim() || target,
      label: phone ? (c.phoneNumbers?.[0]?.number ?? target) : target,
      target,
      isPhone: !!phone,
      hash,
      invited: already.has(hash),
    });
  }

  // Not-yet-invited first (that's what the user is here to do), then A–Z.
  out.sort((a, b) =>
    a.invited === b.invited ? a.name.localeCompare(b.name) : (a.invited ? 1 : -1));
  return { status: 'ok', contacts: out, invitedTotal };
}

/**
 * Open the device's SMS (or mail) composer addressed to everyone selected, with
 * the invite prefilled. One composer for the whole selection — the point is that
 * inviting eight people costs one tap, not eight.
 *
 * Deliberately uses Linking rather than expo-sms: no new native module, so this
 * needs no rebuild.
 */
export async function openInviteComposer(
  contacts: InviteContact[],
  url: string,
  emailIntro: string,
  emailSubject: string,
): Promise<boolean> {
  if (!contacts.length) return false;
  const phones = contacts.filter((c) => c.isPhone).map((c) => c.target);
  const emails = contacts.filter((c) => !c.isPhone).map((c) => c.target);

  try {
    if (phones.length) {
      // THE LINK ALONE — no sentence in front of it. Any text turns the message
      // into a bubble PLUS a card; the bare URL renders as just the card, which
      // is what the invite is (owner, 2026-08-10). The card's own headline
      // carries the message, so nothing is lost. Same rule the app's other
      // shares already follow.
      const body = encodeURIComponent(url);
      // iOS separates recipients with a comma, Android with a semicolon; the
      // body separator differs too (& vs ?) once recipients are present.
      const list = Platform.OS === 'ios' ? phones.join(',') : phones.join(';');
      const sep = Platform.OS === 'ios' ? '&' : '?';
      await Linking.openURL(`sms:${list}${sep}body=${body}`);
      return true;
    }
    if (emails.length) {
      // Email is the exception: mail clients don't draw preview cards, so a
      // bare URL in an empty message reads like spam. Here the sentence stays.
      await Linking.openURL(
        `mailto:${emails.join(',')}?subject=${encodeURIComponent(emailSubject)}`
        + `&body=${encodeURIComponent(`${emailIntro}\n\n${url}`)}`);
      return true;
    }
  } catch { /* no composer on this device */ }
  return false;
}

/**
 * Record the invites and return the new lifetime total. The server recomputes the
 * counter from distinct contacts, so calling this twice with the same people is
 * harmless — which is exactly why the badge can't be farmed.
 */
export async function recordInvites(contacts: InviteContact[]): Promise<number | null> {
  const hashes = contacts.map((c) => c.hash).filter(Boolean);
  if (!hashes.length) return null;
  const { data, error } = await supabase.rpc('record_app_share_contacts', { p_hashes: hashes });
  if (error) return null;
  evaluateBadgesDebounced();
  return typeof data === 'number' ? data : null;
}
