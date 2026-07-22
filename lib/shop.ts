// Shop — the data layer for Laybell's digital-goods marketplace (beats, songs,
// sample packs…). Marketplace model, like Facebook Marketplace: listings are
// discovery + a buy REQUEST; the deal is settled between the parties (usually
// over DMs), then the seller "delivers", which is what unlocks the private
// deliverable file for that buyer (storage RLS keys off delivered orders).
//
// Media layout (matches shop.sql storage policies):
//   'shop'       (public)  <seller_id>/<listing_id>/cover.jpg | preview.<ext>
//   'shop-files' (private) <seller_id>/<listing_id>/<filename>

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

export type Shop = {
  user_id: string;
  name: string;
  bio: string | null;
  is_open: boolean;
  created_at: string;
};

export type ListingCategory = 'beat' | 'song' | 'sample_pack' | 'preset' | 'service' | 'other';
export type ListingLicense = 'exclusive' | 'nonexclusive' | 'free';
export type ListingStatus = 'active' | 'paused' | 'sold' | 'removed';

export type ShopListing = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  category: ListingCategory;
  genre: string | null;
  price_cents: number;
  currency: string;
  license: ListingLicense;
  cover_url: string | null;
  preview_url: string | null;
  file_path: string | null;
  status: ListingStatus;
  sales_count: number;
  created_at: string;
  seller?: SellerProfile;
};

export type SellerProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type OrderStatus = 'requested' | 'delivered' | 'declined' | 'cancelled';

export type ShopOrder = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  status: OrderStatus;
  price_cents: number;
  currency: string;
  note: string | null;
  created_at: string;
  delivered_at: string | null;
  listing?: Pick<ShopListing, 'id' | 'title' | 'cover_url' | 'category' | 'file_path'>;
  buyer?: SellerProfile;
  seller?: SellerProfile;
};

export const LISTING_CATEGORIES: ListingCategory[] = ['beat', 'song', 'sample_pack', 'preset', 'service', 'other'];

// ── Marketplace economics ─────────────────────────────────────────────────────
// Laybell takes 15% of every sale. Sales tax is the BUYER's cost (added on top
// at purchase, Poshmark-style) — it never reduces the seller's take-home.
export const SHOP_FEE_RATE = 0.15;
// Estimated sales tax shown to sellers for context (varies by buyer location).
export const SHOP_TAX_RATE = 0.06;

/** What the seller keeps after Laybell's 15% fee. */
export function sellerEarningsCents(priceCents: number): number {
  return Math.max(0, Math.round(priceCents * (1 - SHOP_FEE_RATE)));
}

/** Laybell's cut on a sale. */
export function shopFeeCents(priceCents: number): number {
  return Math.max(0, priceCents - sellerEarningsCents(priceCents));
}

/** Estimated tax the BUYER pays on top of the listing price. */
export function buyerTaxCents(priceCents: number): number {
  return Math.max(0, Math.round(priceCents * SHOP_TAX_RATE));
}

export function formatPrice(cents: number, currency = 'USD'): string {
  if (cents <= 0) return 'FREE';
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const dollars = cents / 100;
  return `${symbol}${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

async function myId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data?.user?.id;
  if (!id) throw new Error('not signed in');
  return id;
}

async function attachSellers<T extends { user_id: string }>(rows: T[]): Promise<(T & { seller?: SellerProfile })[]> {
  const ids = [...new Set(rows.map((r) => r.user_id))];
  if (!ids.length) return rows;
  const { data } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .in('id', ids);
  const byId = new Map((data ?? []).map((p) => [p.id, p as SellerProfile]));
  return rows.map((r) => ({ ...r, seller: byId.get(r.user_id) }));
}

// --- Shops ----------------------------------------------------------------------

export async function getShop(userId: string): Promise<Shop | null> {
  const { data } = await supabase.from('shops').select('*').eq('user_id', userId).maybeSingle();
  return (data as Shop) ?? null;
}

/** Fast existence check for the profile button (RLS hides closed shops). */
export async function hasOpenShop(userId: string): Promise<boolean> {
  const { data } = await supabase.from('shops').select('user_id').eq('user_id', userId).maybeSingle();
  return !!data;
}

export async function createShop(name: string, bio: string): Promise<Shop> {
  const userId = await myId();
  const { data, error } = await supabase
    .from('shops')
    // accepted_terms_at documents the seller-agreement consent captured by the
    // required checkbox in the create-shop form.
    .insert({ user_id: userId, name: name.trim(), bio: bio.trim() || null, accepted_terms_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data as Shop;
}

export async function updateShop(patch: Partial<Pick<Shop, 'name' | 'bio' | 'is_open'>>): Promise<void> {
  const userId = await myId();
  const { error } = await supabase.from('shops').update(patch).eq('user_id', userId);
  if (error) throw error;
}

// --- Media uploads ----------------------------------------------------------------

async function uploadTo(bucket: string, path: string, uri: string, mime: string): Promise<void> {
  const form = new FormData();
  form.append('file', { uri, name: path.split('/').pop(), type: mime } as never);
  const { error } = await supabase.storage.from(bucket).upload(path, form, { contentType: mime, upsert: true });
  if (error) throw error;
}

export async function uploadListingCover(listingId: string, uri: string): Promise<string> {
  const userId = await myId();
  const path = `${userId}/${listingId}/cover-${Date.now()}.jpg`;
  await uploadTo('shop', path, uri, 'image/jpeg');
  return supabase.storage.from('shop').getPublicUrl(path).data.publicUrl;
}

export async function uploadListingPreview(listingId: string, uri: string, mime: string): Promise<string> {
  const userId = await myId();
  const ext = (uri.split('.').pop() || 'mp3').toLowerCase().slice(0, 5);
  const path = `${userId}/${listingId}/preview-${Date.now()}.${ext}`;
  await uploadTo('shop', path, uri, mime || 'audio/mpeg');
  return supabase.storage.from('shop').getPublicUrl(path).data.publicUrl;
}

/** The private deliverable. Returns the storage PATH (not a URL). */
export async function uploadListingFile(listingId: string, uri: string, mime: string, filename?: string): Promise<string> {
  const userId = await myId();
  const safeName = (filename || uri.split('/').pop() || 'file')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-80);
  const path = `${userId}/${listingId}/${Date.now()}-${safeName}`;
  await uploadTo('shop-files', path, uri, mime || 'application/octet-stream');
  return path;
}

/** Signed URL for a deliverable — works for the seller and delivered buyers. */
export async function getDeliverableUrl(filePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from('shop-files').createSignedUrl(filePath, 3600);
  if (error || !data?.signedUrl) throw error ?? new Error('no url');
  return data.signedUrl;
}

// --- Listings ----------------------------------------------------------------------

const LISTING_COLS = 'id, user_id, title, description, category, genre, price_cents, currency, license, cover_url, preview_url, file_path, status, sales_count, created_at';

export async function createListing(input: {
  title: string;
  description: string;
  category: ListingCategory;
  genre: string;
  priceCents: number;
  license: ListingLicense;
}): Promise<ShopListing> {
  const userId = await myId();
  const { data, error } = await supabase
    .from('shop_listings')
    .insert({
      user_id: userId,
      title: input.title.trim(),
      description: input.description.trim() || null,
      category: input.category,
      genre: input.genre.trim() || null,
      price_cents: input.license === 'free' ? 0 : Math.max(0, Math.round(input.priceCents)),
      license: input.license,
    })
    .select(LISTING_COLS)
    .single();
  if (error) throw error;
  return data as ShopListing;
}

export async function updateListing(id: string, patch: Partial<Omit<ShopListing, 'id' | 'user_id' | 'created_at' | 'sales_count' | 'seller'>>): Promise<void> {
  const { error } = await supabase
    .from('shop_listings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function fetchListing(id: string): Promise<ShopListing | null> {
  const { data } = await supabase.from('shop_listings').select(LISTING_COLS).eq('id', id).maybeSingle();
  if (!data) return null;
  const [row] = await attachSellers([data as ShopListing]);
  return row;
}

export async function fetchSellerListings(userId: string, includeAll = false): Promise<ShopListing[]> {
  let q = supabase
    .from('shop_listings')
    .select(LISTING_COLS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (!includeAll) q = q.eq('status', 'active');
  else q = q.neq('status', 'removed');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ShopListing[];
}

export type ExploreSort = 'new' | 'price' | 'popular';

export async function exploreListings(opts: {
  search?: string;
  category?: ListingCategory | null;
  sort?: ExploreSort;
  offset?: number;
  limit?: number;
} = {}): Promise<ShopListing[]> {
  const { search = '', category = null, sort = 'new', offset = 0, limit = 30 } = opts;
  let q = supabase
    .from('shop_listings')
    .select(LISTING_COLS)
    .eq('status', 'active')
    .range(offset, offset + limit - 1);
  if (sort === 'price') q = q.order('price_cents', { ascending: true }).order('created_at', { ascending: false });
  else if (sort === 'popular') q = q.order('sales_count', { ascending: false }).order('created_at', { ascending: false });
  else q = q.order('created_at', { ascending: false });
  if (category) q = q.eq('category', category);
  const term = search.trim();
  if (term) q = q.or(`title.ilike.%${term}%,genre.ilike.%${term}%,description.ilike.%${term}%`);
  const { data, error } = await q;
  if (error) throw error;
  return attachSellers((data ?? []) as ShopListing[]);
}

// --- Orders ---------------------------------------------------------------------

const ORDER_COLS = 'id, listing_id, buyer_id, seller_id, status, price_cents, currency, note, created_at, delivered_at';

/**
 * Files a buy request and drops a marketplace-style DM to the seller so the
 * conversation (and payment arrangement) starts immediately.
 */
export async function requestToBuy(listing: ShopListing, note: string): Promise<ShopOrder> {
  const buyerId = await myId();
  const { data, error } = await supabase
    .from('shop_orders')
    .insert({
      listing_id: listing.id,
      buyer_id: buyerId,
      seller_id: listing.user_id,
      price_cents: listing.price_cents,
      // Snapshot Laybell's 15% at order time, so a future fee change can't
      // retroactively alter a deal's bookkeeping.
      fee_cents: shopFeeCents(listing.price_cents),
      currency: listing.currency,
      note: note.trim() || null,
    })
    .select(ORDER_COLS)
    .single();
  if (error) throw error;

  const priceText = formatPrice(listing.price_cents, listing.currency);
  const body = `🛍 ${listing.title} — ${priceText}\n${note.trim() ? note.trim() + '\n' : ''}`;
  supabase
    .from('messages')
    .insert({ sender_id: buyerId, receiver_id: listing.user_id, body: body.trim() })
    .then(undefined, () => { /* best effort */ });

  return data as ShopOrder;
}

export async function setOrderStatus(orderId: string, status: 'delivered' | 'declined' | 'cancelled'): Promise<void> {
  const { error } = await supabase.from('shop_orders').update({ status }).eq('id', orderId);
  if (error) throw error;
}

/**
 * Deliver an order AND tell the buyer over DM that their file is unlocked —
 * closing the loop the same way the buy request opened it.
 */
export async function deliverOrder(order: ShopOrder, message: string): Promise<void> {
  await setOrderStatus(order.id, 'delivered');
  supabase
    .from('messages')
    .insert({ sender_id: order.seller_id, receiver_id: order.buyer_id, body: message })
    .then(undefined, () => { /* best effort */ });
}

/** Requested buy orders waiting on the seller — drives the Orders tab badge. */
export async function pendingSalesCount(): Promise<number> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return 0;
  const { count } = await supabase
    .from('shop_orders')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', uid)
    .eq('status', 'requested');
  return count ?? 0;
}

/** The caller's existing order on a listing (drives the listing CTA state). */
export async function myOrderForListing(listingId: string): Promise<ShopOrder | null> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return null;
  const { data } = await supabase
    .from('shop_orders')
    .select(ORDER_COLS)
    .eq('listing_id', listingId)
    .eq('buyer_id', uid)
    .maybeSingle();
  return (data as ShopOrder) ?? null;
}

async function attachOrderMeta(rows: ShopOrder[]): Promise<ShopOrder[]> {
  if (!rows.length) return rows;
  const listingIds = [...new Set(rows.map((r) => r.listing_id))];
  const userIds = [...new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id]))];
  const [{ data: listings }, { data: profiles }] = await Promise.all([
    supabase.from('shop_listings').select('id, title, cover_url, category, file_path').in('id', listingIds),
    supabase.from('profiles').select('id, username, display_name, avatar_url').in('id', userIds),
  ]);
  const listingById = new Map((listings ?? []).map((l) => [l.id, l]));
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p as SellerProfile]));
  return rows.map((r) => ({
    ...r,
    listing: listingById.get(r.listing_id) as ShopOrder['listing'],
    buyer: profileById.get(r.buyer_id),
    seller: profileById.get(r.seller_id),
  }));
}

/** Orders on MY listings (sales) — requested first, then recent history. */
export async function fetchMySales(): Promise<ShopOrder[]> {
  const uid = await myId();
  const { data, error } = await supabase
    .from('shop_orders')
    .select(ORDER_COLS)
    .eq('seller_id', uid)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return attachOrderMeta((data ?? []) as ShopOrder[]);
}

/** My buy requests + purchases. */
export async function fetchMyPurchases(): Promise<ShopOrder[]> {
  const uid = await myId();
  const { data, error } = await supabase
    .from('shop_orders')
    .select(ORDER_COLS)
    .eq('buyer_id', uid)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return attachOrderMeta((data ?? []) as ShopOrder[]);
}

// ── Unseen shop activity (the profile Shop-button alert dot) ─────────────────
// "Needs my eyes" = (a) buy requests still waiting on me as the SELLER — these
// are UNADDRESSED until delivered/declined, so they count even after being
// seen (same persistence as the Orders-tab badge) — plus (b) order OUTCOMES I
// haven't seen as the BUYER (my file was delivered / my offer was declined).
// Seen-tracking is a local order-id → status snapshot captured whenever the
// Orders tab is viewed: status CHANGES re-alert, no schema changes needed.

const ORDERS_SEEN_KEY = 'shop_orders_seen_v1';

async function loadOrdersSeen(uid: string): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(`${ORDERS_SEEN_KEY}_${uid}`);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/** Snapshot the orders the user just looked at (called by the Orders tab). */
export async function markShopOrdersSeen(orders: Pick<ShopOrder, 'id' | 'status'>[]): Promise<void> {
  try {
    if (!orders.length) return;
    const uid = await myId();
    const seen = await loadOrdersSeen(uid);
    for (const o of orders) seen[o.id] = o.status;
    await AsyncStorage.setItem(`${ORDERS_SEEN_KEY}_${uid}`, JSON.stringify(seen));
  } catch { /* best effort */ }
}

/** How many orders want attention — drives the red dot on the profile Shop button. */
export async function unseenShopActivityCount(): Promise<number> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return 0;
    const { data } = await supabase
      .from('shop_orders')
      .select('id, status, seller_id, buyer_id')
      .or(`seller_id.eq.${uid},buyer_id.eq.${uid}`)
      .order('created_at', { ascending: false })
      .limit(100);
    const rows = (data ?? []) as Pick<ShopOrder, 'id' | 'status' | 'seller_id' | 'buyer_id'>[];
    if (!rows.length) return 0;
    const seen = await loadOrdersSeen(uid);
    let n = 0;
    for (const r of rows) {
      // Seller: a pending request is unaddressed — always counts.
      if (r.seller_id === uid && r.status === 'requested') { n += 1; continue; }
      // Buyer: a delivered/declined outcome counts until the Orders tab has
      // been opened with that exact status on record.
      if (r.buyer_id === uid && (r.status === 'delivered' || r.status === 'declined') && seen[r.id] !== r.status) n += 1;
    }
    return n;
  } catch { return 0; } // pre-migration → no dot
}
