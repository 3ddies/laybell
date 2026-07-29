import { supabase } from './supabase';

// Read side of the Laybell ledger (supabase/sql/ledger.sql).
//
// READ-ONLY BY DESIGN. There is no post/credit/debit function here and there must
// never be one: every value movement happens server-side, in an edge function
// holding the service role, because a client that can move money is a client that
// can mint it. RLS enforces this independently — `authenticated` has no write
// grant on any ledger table and no execute grant on ledger_post.
//
// Two balances matter and they are not interchangeable:
//   credits  — bought with real money, SPEND-ONLY, never withdrawable. Keeping
//              them non-cashable is what keeps Laybell clear of stored-value and
//              state money-transmitter licensing. Never add a path to cash.
//   earnings — what a creator earned and can withdraw via Stripe Connect, once
//              past its hold.
//
// Degrades gracefully: before ledger.sql is applied every call returns empty
// zeros, which reads as "no money", the safe answer.

export type LedgerKind = 'credits' | 'earnings' | 'platform';

export type LedgerBalance = {
  /** Everything the account holds, including money still on hold. */
  totalCents: number;
  /** Withdrawable/spendable right now — excludes held funds. */
  availableCents: number;
};

export type LedgerBalances = {
  credits: LedgerBalance;
  earnings: LedgerBalance;
  /** True once the ledger exists and answered. False pre-migration. */
  ready: boolean;
};

const ZERO: LedgerBalance = { totalCents: 0, availableCents: 0 };

export const EMPTY_BALANCES: LedgerBalances = { credits: ZERO, earnings: ZERO, ready: false };

export async function fetchLedgerBalances(): Promise<LedgerBalances> {
  try {
    const { data, error } = await supabase.rpc('my_ledger_balance');
    if (error || !data) return EMPTY_BALANCES;
    const out: LedgerBalances = { credits: { ...ZERO }, earnings: { ...ZERO }, ready: true };
    for (const row of data as any[]) {
      const kind = row?.kind as LedgerKind;
      if (kind !== 'credits' && kind !== 'earnings') continue;
      out[kind] = {
        totalCents: Number(row.total_cents ?? 0),
        availableCents: Number(row.available_cents ?? 0),
      };
    }
    return out;
  } catch {
    return EMPTY_BALANCES;
  }
}

export type LedgerStatementRow = {
  id: string;
  created_at: string;
  amount_cents: number;
  available_at: string;
  account_kind: LedgerKind;
  transaction_kind: string;
  source: string;
  memo: string | null;
};

/** The user's own movements, newest first — what a wallet statement shows. */
export async function fetchLedgerStatement(limit = 50): Promise<LedgerStatementRow[]> {
  try {
    const { data, error } = await supabase
      .from('my_ledger_statement').select('*').limit(limit);
    if (error || !data) return [];
    return data as LedgerStatementRow[];
  } catch {
    return [];
  }
}

/** Money earned but still inside its hold window — shown as "pending". */
export function heldCents(b: LedgerBalance): number {
  return Math.max(0, b.totalCents - b.availableCents);
}
