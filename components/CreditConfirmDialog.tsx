import { useRouter } from 'expo-router';
import ConfirmDialog from './ConfirmDialog';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { formatPrice } from '../lib/shop';

// The last step before credits move: what it costs, what you hold, and — when
// those don't meet — how far short you are and a way to fix it.
//
// ONE component for the listing buttons and the cart, deliberately. The two used
// to disagree: the listing spent first and routed to /credits from the error
// handler afterwards, the cart reported "no longer available" for what was
// actually an empty balance. Both now ask the same question in the same words,
// and the branch between "buy" and "go top up" lives here rather than in each
// caller, so it cannot drift.
//
// THE BALANCE IS PASSED IN, not fetched here. The caller reads it before opening
// the dialog, so the numbers are on screen the moment it appears instead of
// resolving under the user. It is also only ever advisory: the ledger is what
// actually refuses an overdraft (ledger_post will not settle a user account
// negative), so a stale reading here costs a clear error, never a bad debit.

export default function CreditConfirmDialog({
  visible,
  priceCents,
  balanceCents,
  currency = 'USD',
  itemLabel,
  onBuy,
  onCancel,
}: {
  visible: boolean;
  priceCents: number;
  /** Credits held, in cents. Compared against `total`, which is what the ledger
   *  itself checks and what the credits screen shows. */
  balanceCents: number;
  currency?: string;
  /** What is being bought — a listing title, or "3 items" for the cart. */
  itemLabel: string;
  onBuy: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const enough = balanceCents >= priceCents;
  const price = formatPrice(priceCents, currency);
  const balance = formatPrice(balanceCents, currency);
  const short = formatPrice(Math.max(0, priceCents - balanceCents), currency);

  return (
    <ConfirmDialog
      visible={visible}
      icon={enough ? 'cart' : 'wallet-outline'}
      // Green for a purchase that can go through, so it reads as the same money
      // affirmative as the Buy button itself. Not destructive either way — this
      // is a spend, not a deletion.
      accentColor={enough ? colors.success : colors.primary}
      title={enough ? t('shop.confirmBuy.title') : t('shop.confirmBuy.shortTitle')}
      message={enough
        ? t('shop.confirmBuy.body', { item: itemLabel, price, balance })
        : t('shop.confirmBuy.shortBody', { price, balance, short })}
      confirmLabel={enough ? t('shop.confirmBuy.confirm') : t('shop.confirmBuy.getCredits')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => {
        if (enough) { onBuy(); return; }
        // Close before navigating: a route pushed while this is up would present
        // behind it. Same reason the free-claim sheet is not a Modal.
        onCancel();
        router.push('/credits');
      }}
      onCancel={onCancel}
    />
  );
}
