import { Alert } from 'react-native';
import { supabase } from './supabase';

// Shared account hide / delete flow so screens other than Settings (e.g. the
// Privacy Center) can offer it without duplicating the wording. Mirrors the
// Settings flow: a 3-month hide-grace path, an immediate-delete path, or cancel.
// Final removal is completed server-side per supabase/sql/account_hidden.sql
// (this sets the delete flags + signs the user out).
async function flagDeletion(extra: Record<string, any>, signOut: boolean, okTitle?: string, okMsg?: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase
    .from('profiles')
    .update({ hidden: true, delete_requested_at: new Date().toISOString(), ...extra })
    .eq('id', user.id);
  if (error) { Alert.alert('Could not update', error.message); return; }
  if (signOut) await supabase.auth.signOut();
  else if (okTitle) Alert.alert(okTitle, okMsg ?? '');
}

export function confirmDeleteAccount() {
  Alert.alert(
    'Delete Account',
    'Before you go — you can hide your account instead. It disappears from Laybell, and if you stay away for 3 months it gets deleted permanently. Coming back and unhiding cancels everything.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Hide for 3 months',
        onPress: () => flagDeletion(
          { delete_immediately: false }, false,
          'Profile hidden',
          'Your account is now invisible. If you stay away for 3 months it will be permanently deleted — unhide in Settings anytime to cancel.',
        ),
      },
      {
        text: 'Delete now',
        style: 'destructive',
        onPress: () => Alert.alert(
          'Delete permanently?',
          'This cannot be undone. Your account and everything you posted will be removed.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: () => flagDeletion({ delete_immediately: true }, true) },
          ],
        ),
      },
    ],
  );
}
