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

/** How an order came about: an exclusive buy, a lease copy, a free claim, or a
    buyer-priced offer on a lease-only listing. Legacy orders have no kind. */
export type SaleKind = 'sell' | 'lease' | 'free' | 'offer';

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
  // Multi-type columns (shop_multi.sql) — absent on a pre-migration database;
  // saleTypes()/priceForKind() fall back to the legacy license axis.
  sell_enabled?: boolean;
  sell_price_cents?: number;
  lease_enabled?: boolean;
  lease_price_cents?: number;
  free_enabled?: boolean;
  free_requires_follow?: boolean;
  free_like_post_ids?: string[];
  seller?: SellerProfile;
};

export type SellerProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type OrderStatus = 'requested' | 'delivered' | 'declined' | 'cancelled' | 'refunded';

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
  // shop_multi.sql — null/absent on legacy orders and pre-migration databases.
  kind?: SaleKind | null;
  refunded_at?: string | null;
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

// ── Multi-type helpers ────────────────────────────────────────────────────────

export type SaleTypes = { sell: boolean; lease: boolean; free: boolean };

/** The deal types a listing offers. Flag columns win; rows created before
    shop_multi.sql (no flags set) fall back to the legacy single license. */
export function saleTypes(l: ShopListing): SaleTypes {
  if (l.sell_enabled || l.lease_enabled || l.free_enabled) {
    return { sell: !!l.sell_enabled, lease: !!l.lease_enabled, free: !!l.free_enabled };
  }
  return {
    sell: l.license === 'exclusive',
    lease: l.license === 'nonexclusive',
    free: l.license === 'free',
  };
}

/** Asking price for one deal type (legacy rows use the single price column). */
export function priceForKind(l: ShopListing, kind: 'sell' | 'lease' | 'free'): number {
  if (kind === 'free') return 0;
  if (kind === 'sell') return l.sell_enabled ? (l.sell_price_cents ?? 0) : l.price_cents;
  return l.lease_enabled ? (l.lease_price_cents ?? 0) : l.price_cents;
}

/** The kind a legacy (pre-multi) order implicitly was, from its listing. */
export function legacyKindOf(l: ShopListing): SaleKind {
  return l.license === 'exclusive' ? 'sell' : l.license === 'free' ? 'free' : 'lease';
}

/** Card-tag label: cheapest paid price ("+" when there's more than one way to
    get it), or FREE for free-only listings. */
export function listingPriceLabel(l: ShopListing, freeWord: string): string {
  const types = saleTypes(l);
  const paid: number[] = [];
  if (types.sell) paid.push(priceForKind(l, 'sell'));
  if (types.lease) paid.push(priceForKind(l, 'lease'));
  const ways = paid.length + (types.free ? 1 : 0);
  if (!paid.length) return freeWord;
  const min = Math.min(...paid);
  const base = min <= 0 ? freeWord : formatPrice(min, l.currency);
  return ways > 1 ? `${base}+` : base;
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

// '*' (not an explicit column list) so the multi-type columns flow in when the
// migration has run, and everything still works when it hasn't.
const LISTING_COLS = '*';

export type ListingTypesInput = {
  sell: { enabled: boolean; priceCents: number };
  lease: { enabled: boolean; priceCents: number };
  free: { enabled: boolean; requiresFollow: boolean; likePostIds: string[] };
};

/** Legacy single-axis mirror of a multi-type config — written alongside the
    flags so old clients and pre-migration databases keep working. */
function legacyAxisOf(types: ListingTypesInput): { license: ListingLicense; price_cents: number } {
  if (types.sell.enabled) return { license: 'exclusive', price_cents: Math.max(0, Math.round(types.sell.priceCents)) };
  if (types.lease.enabled) return { license: 'nonexclusive', price_cents: Math.max(0, Math.round(types.lease.priceCents)) };
  return { license: 'free', price_cents: 0 };
}

function multiColumnsOf(types: ListingTypesInput) {
  return {
    sell_enabled: types.sell.enabled,
    sell_price_cents: types.sell.enabled ? Math.max(0, Math.round(types.sell.priceCents)) : 0,
    lease_enabled: types.lease.enabled,
    lease_price_cents: types.lease.enabled ? Math.max(0, Math.round(types.lease.priceCents)) : 0,
    free_enabled: types.free.enabled,
    free_requires_follow: types.free.enabled && types.free.requiresFollow,
    free_like_post_ids: types.free.enabled ? types.free.likePostIds : [],
  };
}

export async function createListing(input: {
  title: string;
  description: string;
  category: ListingCategory;
  genre: string;
  types: ListingTypesInput;
}): Promise<ShopListing> {
  const userId = await myId();
  const base = {
    user_id: userId,
    title: input.title.trim(),
    description: input.description.trim() || null,
    category: input.category,
    genre: input.genre.trim() || null,
    ...legacyAxisOf(input.types),
  };
  // Full multi-type insert; a pre-migration database rejects the unknown
  // columns, so retry with the legacy axis only (the primary type survives).
  let { data, error } = await supabase
    .from('shop_listings')
    .insert({ ...base, ...multiColumnsOf(input.types) })
    .select(LISTING_COLS)
    .single();
  if (error) {
    ({ data, error } = await supabase.from('shop_listings').insert(base).select(LISTING_COLS).single());
  }
  if (error) throw error;
  return data as ShopListing;
}

/** Update a listing's deal types (multi columns + legacy mirror). */
export async function updateListingTypes(id: string, types: ListingTypesInput): Promise<void> {
  const patch = { ...legacyAxisOf(types), ...multiColumnsOf(types), updated_at: new Date().toISOString() };
  const { error } = await supabase.from('shop_listings').update(patch).eq('id', id);
  if (error) {
    // Pre-migration database — persist at least the legacy axis.
    const { error: e2 } = await supabase
      .from('shop_listings')
      .update({ ...legacyAxisOf(types), updated_at: new Date().toISOString() })
      .eq('id', id);
    if (e2) throw e2;
  }
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

const ORDER_COLS = '*';

/**
 * Files a buy request for ONE deal type and drops a marketplace-style DM to
 * the seller so the conversation (and payment arrangement) starts immediately.
 *  - 'sell' / 'lease': price comes from that type's asking price.
 *  - 'free': a claim — the server checks the unlock conditions and, when they
 *    pass, delivers INSTANTLY (the returned order is already 'delivered').
 *  - 'offer': the buyer names their own price (offerCents) on a lease-only
 *    listing; the seller accepting = an exclusive sale.
 */
export async function requestToBuy(
  listing: ShopListing,
  note: string,
  kind: SaleKind = legacyKindOf(listing),
  offerCents = 0,
): Promise<ShopOrder> {
  const buyerId = await myId();
  const priceCents = kind === 'offer'
    ? Math.max(0, Math.round(offerCents))
    : priceForKind(listing, kind);
  const base = {
    listing_id: listing.id,
    buyer_id: buyerId,
    seller_id: listing.user_id,
    price_cents: priceCents,
    // Snapshot Laybell's 15% at order time, so a future fee change can't
    // retroactively alter a deal's bookkeeping.
    fee_cents: shopFeeCents(priceCents),
    currency: listing.currency,
    note: note.trim() || null,
  };
  let { data, error } = await supabase
    .from('shop_orders')
    .insert({ ...base, kind })
    .select(ORDER_COLS)
    .single();
  if (error && kind !== 'offer' && `${error.message}`.includes('kind')) {
    // Pre-migration database (no kind column) — legacy single-type request.
    // Offers genuinely need the migration, so those stay failed.
    ({ data, error } = await supabase.from('shop_orders').insert(base).select(ORDER_COLS).single());
  }
  if (error) throw error;

  const priceText = formatPrice(priceCents, listing.currency);
  const body = kind === 'offer'
    ? `💰 ${priceText} — ${listing.title}\n${note.trim() ? note.trim() + '\n' : ''}`
    : kind === 'free'
      ? `🎁 ${listing.title}`
      : `🛍 ${listing.title} — ${priceText}\n${note.trim() ? note.trim() + '\n' : ''}`;
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

/** The caller's orders on a listing, one per deal type at most (drives the
    per-kind CTA states on the listing screen). */
export async function myOrdersForListing(listingId: string): Promise<ShopOrder[]> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return [];
  const { data } = await supabase
    .from('shop_orders')
    .select(ORDER_COLS)
    .eq('listing_id', listingId)
    .eq('buyer_id', uid)
    .order('created_at', { ascending: false });
  return (data ?? []) as ShopOrder[];
}

// ── Free-unlock conditions ────────────────────────────────────────────────────

export type FreeConditionState = {
  followMet: boolean;
  likes: { postId: string; met: boolean }[];
  allMet: boolean;
  /** False when the listing has no conditions at all (claim is ungated). */
  hasConditions: boolean;
};

/** Client-side mirror of the server's free-claim gate — powers the checklist
    UI. The shop_order_precheck trigger re-verifies everything on claim. */
export async function checkFreeConditions(listing: ShopListing): Promise<FreeConditionState> {
  const needFollow = !!listing.free_requires_follow;
  const postIds = listing.free_like_post_ids ?? [];
  if (!needFollow && !postIds.length) {
    return { followMet: true, likes: [], allMet: true, hasConditions: false };
  }
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) return { followMet: !needFollow, likes: postIds.map((p) => ({ postId: p, met: false })), allMet: false, hasConditions: true };

  const [followRes, likesRes] = await Promise.all([
    needFollow
      ? supabase.from('follows').select('follower_id').eq('follower_id', uid).eq('following_id', listing.user_id).maybeSingle()
      : Promise.resolve({ data: true } as { data: unknown }),
    postIds.length
      ? supabase.from('likes').select('post_id').eq('user_id', uid).in('post_id', postIds)
      : Promise.resolve({ data: [] } as { data: { post_id: string }[] }),
  ]);
  const followMet = !needFollow || !!followRes.data;
  const likedSet = new Set(((likesRes.data ?? []) as { post_id: string }[]).map((l) => l.post_id));
  const likes = postIds.map((postId) => ({ postId, met: likedSet.has(postId) }));
  return {
    followMet,
    likes,
    allMet: followMet && likes.every((l) => l.met),
    hasConditions: true,
  };
}

// ── Takedown protection ───────────────────────────────────────────────────────

/** Whether a listing has DELIVERED purchases (blocks plain removal). */
export async function hasDeliveredSales(listingId: string): Promise<boolean> {
  const { count } = await supabase
    .from('shop_orders')
    .select('id', { count: 'exact', head: true })
    .eq('listing_id', listingId)
    .eq('status', 'delivered');
  return (count ?? 0) > 0;
}

/** The only way to take down a purchased listing: refunds every delivered
    buyer (they lose file access), then removes it. Server-side RPC. */
export async function refundAndRemoveListing(listingId: string): Promise<boolean> {
  const { error } = await supabase.rpc('refund_and_remove_listing', { p_listing: listingId });
  return !error;
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

/**
 * Total seller take-home (cents) from DELIVERED orders, summed SERVER-SIDE so it
 * isn't truncated by fetchMySales' 100-row page cap (which under-counts a seller
 * with >100 orders). Uses the same formula as sellerEarningsCents, just uncapped.
 * Falls back to the page-capped client sum if the delivered_earnings RPC isn't
 * deployed yet, so behavior is unchanged until supabase/sql/wallet_earnings.sql
 * is run.
 */
export async function fetchDeliveredShopEarningsCents(): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('delivered_earnings');
    if (!error && data?.[0]) return Number(data[0].total_cents ?? 0);
  } catch {}
  const sales = await fetchMySales().catch(() => [] as ShopOrder[]);
  return sales
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + sellerEarningsCents(o.price_cents), 0);
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
