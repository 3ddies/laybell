import { Alert } from 'react-native';
import { supabase } from './supabase';
import { tg } from './i18n';

// Shared account hide / delete flow so screens other than Settings (e.g. the
// Privacy Center) can offer it without duplicating the wording. Mirrors the
// Settings flow: a 3-month hide-grace path, a delete path (hard-deleted 48h later
// by the sweep), or cancel. This sets the delete flags + signs the user out; the
// actual removal runs server-side (supabase/sql/account_deletion_sweep.sql).
async function flagDeletion(extra: Record<string, any>, signOut: boolean, okTitle?: string, okMsg?: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase
    .from('profiles')
    .update({ hidden: true, delete_requested_at: new Date().toISOString(), ...extra })
    .eq('id', user.id);
  if (error) { Alert.alert(tg('hide.couldNotUpdate'), error.message); return; }
  // Permanent ("Delete now") path: the account is flagged now — access stops
  // immediately via sign-out + the _layout login guard — and it is HARD-DELETED
  // 48 hours later by the sweep (supabase/sql/account_deletion_sweep.sql), unless
  // it has reports or a legal hold (those are handled manually). Once the hard
  // delete runs, the email frees up for a new account.
  if (signOut) {
    // Reported accounts are excluded from the 48h sweep (handled manually), so
    // don't promise them the email reuse — that would be misleading. Check while
    // still authenticated, before sign-out.
    let reported = false;
    if (extra.delete_immediately === true) {
      try { const { data } = await supabase.rpc('current_account_has_reports'); reported = data === true; } catch {}
    }
    await supabase.auth.signOut();
    if (extra.delete_immediately === true) {
      Alert.alert(tg('delete.doneTitle'), reported
        ? tg('delete.doneReported')
        : tg('delete.doneClean'));
    }
  } else if (okTitle) {
    Alert.alert(okTitle, okMsg ?? '');
  }
}

export function confirmDeleteAccount() {
  Alert.alert(
    tg('danger.deleteAccount'),
    tg('delete.body'),
    [
      { text: tg('common.cancel'), style: 'cancel' },
      {
        text: tg('delete.hide3mo'),
        onPress: () => flagDeletion(
          { delete_immediately: false }, false,
          tg('delete.hiddenTitle'),
          tg('delete.hiddenBody'),
        ),
      },
      {
        text: tg('delete.deleteNow'),
        style: 'destructive',
        onPress: () => Alert.alert(
          tg('delete.permTitle'),
          tg('delete.permBody'),
          [
            { text: tg('common.cancel'), style: 'cancel' },
            { text: tg('common.delete'), style: 'destructive', onPress: () => flagDeletion({ delete_immediately: true }, true) },
          ],
        ),
      },
    ],
  );
}
