import { readFileSync, writeFileSync } from 'node:fs';

const NL_OF = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
function mk(F) {
  let s = readFileSync(F, 'utf8');
  const NL = NL_OF(s);
  return {
    L: (a) => a.join(NL),
    once(find, make, label) {
      const p = s.split(find);
      if (p.length !== 2) { console.error(`FAIL ${F} ${label}: ${p.length - 1}x`); process.exit(1); }
      s = p[0] + make + p[1];
      console.log(`  ok  ${F}: ${label}`);
    },
    save() { writeFileSync(F, s, 'utf8'); },
  };
}

// ── lib/shop.ts ─────────────────────────────────────────────────────────────
{
  const F = 'lib/shop.ts';
  const e = mk(F); const L = e.L;

  e.once(
    L([
      '/** Of these listings, which have I already been DELIVERED?',
      ' *',
      ' *  One query for a whole cart rather than one per item. Used to drop things the',
      ' *  buyer already owns — an exclusive they bought, or a free claim — which would',
      ' *  otherwise sit in the cart forever failing at checkout. */',
      'export async function myDeliveredListingIds(listingIds: string[]): Promise<Set<string>> {',
      '  const unique = [...new Set(listingIds.filter(Boolean))];',
      '  if (!unique.length) return new Set();',
      '  const { data: auth } = await supabase.auth.getUser();',
      '  const uid = auth?.user?.id;',
      '  if (!uid) return new Set();',
      '  const { data } = await supabase',
      "    .from('shop_orders')",
      "    .select('listing_id')",
      "    .eq('buyer_id', uid)",
      "    .eq('status', 'delivered')",
      "    .in('listing_id', unique);",
      '  return new Set((data ?? []).map((r: { listing_id: string }) => r.listing_id));',
      '}',
    ]),
    L([
      '/** Which DEAL KINDS of these listings have I already been delivered?',
      ' *',
      ' *  Per KIND, not per listing, and that distinction is the point: leasing a beat',
      ' *  or claiming it free does not end anything. The buyer can still come back and',
      ' *  buy it outright — that is what they would be paying for. Only the kind they',
      ' *  already hold is spent, because orders are unique per (listing, buyer, kind).',
      ' *',
      ' *  One query for a whole cart rather than one per item. Legacy orders predate',
      " *  `kind` and are keyed 'legacy', which matches nothing a client adds today. */",
      'export async function myDeliveredKinds(listingIds: string[]): Promise<Map<string, Set<string>>> {',
      '  const out = new Map<string, Set<string>>();',
      '  const unique = [...new Set(listingIds.filter(Boolean))];',
      '  if (!unique.length) return out;',
      '  const { data: auth } = await supabase.auth.getUser();',
      '  const uid = auth?.user?.id;',
      '  if (!uid) return out;',
      '  const { data } = await supabase',
      "    .from('shop_orders')",
      "    .select('listing_id, kind')",
      "    .eq('buyer_id', uid)",
      "    .eq('status', 'delivered')",
      "    .in('listing_id', unique);",
      '  for (const r of (data ?? []) as { listing_id: string; kind: string | null }[]) {',
      '    const set = out.get(r.listing_id) ?? new Set<string>();',
      "    set.add(r.kind ?? 'legacy');",
      '    out.set(r.listing_id, set);',
      '  }',
      '  return out;',
      '}',
    ]),
    'myDeliveredListingIds -> myDeliveredKinds',
  );

  e.once(
    'export type ListingStats = { claimed: number; leased: number; sold: boolean };',
    L([
      '/** Deliveries that were actually PAID FOR — buys, leases and accepted offers.',
      ' *',
      ' *  sales_count counts every delivery including free claims, which are not sales',
      ' *  by any reading: nothing changed hands. A shop advertising "12 sold" on the',
      ' *  back of twelve giveaways is overstating itself to buyers and to its owner. */',
      'export function paidSalesCount(l: ShopListing): number {',
      '  return Math.max(0, l.sales_count - (l.free_count ?? 0));',
      '}',
      '',
      'export type ListingStats = { claimed: number; leased: number; sold: boolean };',
    ]),
    'paidSalesCount',
  );
  e.save();
}

// ── cart ────────────────────────────────────────────────────────────────────
{
  const F = 'app/shop/cart.tsx';
  const e = mk(F); const L = e.L;

  e.once(
    "import { fetchListing, formatPrice, myDeliveredListingIds, requestToBuy } from '../../lib/shop';",
    "import { fetchListing, formatPrice, legacyKindOf, myDeliveredKinds, requestToBuy } from '../../lib/shop';",
    'import',
  );

  e.once(
    L([
      '      const [listings, owned] = await Promise.all([',
      '        Promise.all(ids.map((id) => fetchListing(id).catch(() => null))),',
      '        myDeliveredKinds(ids).catch(() => new Set<string>()),',
      '      ]);',
      '      if (!alive) return;',
      '      const dead = ids.filter((id, i) => {',
      '        const l = listings[i];',
      "        return !l || l.status !== 'active' || owned.has(id);",
      '      });',
    ]),
    L([
      '      const [listings, held] = await Promise.all([',
      '        Promise.all(ids.map((id) => fetchListing(id).catch(() => null))),',
      '        myDeliveredKinds(ids).catch(() => new Map<string, Set<string>>()),',
      '      ]);',
      '      if (!alive) return;',
      '      const cart = getCartItems();',
      '      const dead = ids.filter((id, i) => {',
      '        const l = listings[i];',
      "        if (!l || l.status !== 'active') return true;",
      '        // Only the KIND already held is spent. Having leased a beat, or claimed',
      '        // it free, leaves buying it outright perfectly available — so an item',
      '        // shortlisted as a buy survives a lease the buyer already has.',
      '        const kind = cart.find((c) => c.listingId === id)?.kind ?? legacyKindOf(l);',
      '        return held.get(id)?.has(kind) ?? false;',
      '      });',
    ]),
    'prune by kind, not by listing',
  );
  e.save();
}

// ── listing screen ──────────────────────────────────────────────────────────
{
  const F = 'app/shop/listing/[id].tsx';
  const e = mk(F); const L = e.L;

  e.once(
    L([
      "  // The cover's cart button. Same rule the grid tiles use — an active listing",
      '  // that is not yours — plus the one thing a tile cannot know and this screen',
      '  // can: whether you have already been delivered it, in which case there is',
      '  // nothing left to shortlist.',
      "  const canCartHere = !!listing && listing.status === 'active' && !isOwner && !deliveredOrder;",
    ]),
    L([
      '  // Which deals this buyer already holds. Orders are unique per (listing, buyer,',
      '  // kind), so a kind already delivered is spent — but ONLY that kind. Leasing a',
      '  // beat or claiming it free ends nothing: buying it outright is still open, and',
      '  // is precisely what the buyer would be paying for.',
      '  const heldKinds = new Set(',
      '    orders',
      "      .filter((o) => o.status === 'delivered')",
      '      .map((o) => o.kind ?? (listing ? legacyKindOf(listing) : null))',
      '      .filter(Boolean) as string[],',
      '  );',
      '  // What the cover button would shortlist: the everyday deal first, then the',
      '  // buy-out, then the freebie — skipping any the buyer already has. Null when',
      '  // there is nothing left to add, which is the only case that hides the button.',
      "  const cartKindHere: Exclude<SaleKind, 'offer'> | null = !listing ? null",
      "    : types.lease && !heldKinds.has('lease') ? 'lease'",
      "      : types.sell && !heldKinds.has('sell') ? 'sell'",
      "        : types.free && !heldKinds.has('free') ? 'free'",
      '          : null;',
      "  const canCartHere = !!listing && listing.status === 'active' && !isOwner && !!cartKindHere;",
    ]),
    'cart gate is per-kind',
  );

  e.once(
    "                    onPress={() => { reactionPop(); inCart ? removeFromCart(listing.id) : addToCart(listing); }}",
    "                    onPress={() => { reactionPop(); inCart ? removeFromCart(listing.id) : addToCart(listing, cartKindHere ?? undefined); }}",
    'shortlist the available kind',
  );

  // The load() prune must not evict a lease-holder who could still buy.
  e.once(
    L([
      '      // Bought here, bought elsewhere, or sold to someone else — either way it',
      '      // can never check out again, so it leaves the cart the moment this screen',
      '      // finds out. The cart prunes on focus as well; this just catches it at the',
      '      // exact point the user is looking at the thing that changed.',
      "      if (!l || l.status !== 'active' || os.some((o) => o.status === 'delivered')) {",
      '        removeFromCart(id);',
      '      }',
    ]),
    L([
      '      // Gone, or closed to everyone by an exclusive sale — it can never check out',
      '      // again, so it leaves the cart the moment this screen finds out.',
      '      //',
      '      // Deliberately NOT "has a delivered order": a lease or a free claim leaves',
      '      // the buy-out open, and evicting the cart item over one would take away a',
      '      // purchase the buyer is still entitled to make. Whether the specific',
      '      // shortlisted KIND is spent is the cart\'s own check, which knows it.',
      "      if (!l || l.status !== 'active') removeFromCart(id);",
    ]),
    'listing prune only on truly dead listings',
  );
  e.save();
}

// ── the two "Sold" stats ────────────────────────────────────────────────────
{
  const F = 'app/shop/index.tsx';
  const e = mk(F);
  e.once(
    '<Text style={styles.statValue}>{listings.reduce((s, l) => s + l.sales_count, 0)}</Text>',
    '<Text style={styles.statValue}>{listings.reduce((s, l) => s + paidSalesCount(l), 0)}</Text>',
    'statsSold excludes free claims',
  );
  e.save();
}
{
  const F = 'app/shop/[userId].tsx';
  const e = mk(F);
  e.once(
    "{t('shop.shopMeta', { n: listings.length, m: listings.reduce((s, l) => s + l.sales_count, 0) })}",
    "{t('shop.shopMeta', { n: listings.length, m: listings.reduce((s, l) => s + paidSalesCount(l), 0) })}",
    'shopMeta excludes free claims',
  );
  e.save();
}

console.log('written');
