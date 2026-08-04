import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { GRADIENTS, RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { notifySuccess } from '../lib/haptics';
import { joinByCode } from '../lib/studio';
import { studioSessionOpen, type ParsedStudioInvite } from '../lib/studioInvite';

// A studio-session invite, rendered in the DM thread as a card rather than a
// chat bubble — the recipient joins where they read it.
//
// The SESSION's status is the truth, not the message: a message can't be edited
// after sending, so an invite to a session the host has since ended would
// otherwise offer a Join that fails.
//
// But "can't read the session" is NOT "the session ended". studio_sessions has
// deliberately no public SELECT policy — join_code is the room credential — so
// the invitee cannot see the row until they are a member. The first version
// treated that missing row as ended, which made the card flash Join and then
// declare a live session over before the recipient could tap it. Only an
// explicit 'ended' status closes the card now; everything else shows Join and
// lets joinByCode be the arbiter.
//
// Joining goes through joinByCode, NOT a direct navigate: the code is the
// capability that adds you to studio_session_members. Navigating straight to
// /studio/<id> would land a non-member in a room they can't participate in.

export default function StudioInviteCard({
  invite,
  isOwn,
}: {
  invite: ParsedStudioInvite;
  /** The current user STARTED the session. They reopen it rather than join. */
  isOwn: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // null = still checking; true/false = known; undefined never used.
  const [open, setOpen] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    studioSessionOpen(invite.sessionId).then((v) => {
      // null = UNKNOWN, and unknown is the NORMAL case here: studio_sessions has
      // no public SELECT policy (join_code is the room credential), so the person
      // being invited cannot read the row until they join. Treat it as open —
      // only an explicit 'ended', which a member can see, closes the card.
      if (alive) setOpen(v === null ? true : v);
    });
    return () => { alive = false; };
  }, [invite.sessionId]);

  async function join() {
    if (busy) return;
    setBusy(true); setFailed(false);
    try {
      if (isOwn) {
        // The host is already a member; joining again is a no-op round trip.
        router.push(`/studio/${invite.sessionId}`);
      } else {
        const sessionId = await joinByCode(invite.code);
        notifySuccess();
        router.push(`/studio/${sessionId}`);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const ended = open === false;

  return (
    <View style={[styles.card, isOwn ? styles.cardOwn : styles.cardOther]}>
      <View style={styles.head}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.icon}>
          <Ionicons name="mic" size={17} color="#fff" />
        </LinearGradient>
        <View style={styles.headText}>
          <Text style={styles.kicker}>{t('studioInvite.kicker')}</Text>
          <Text style={styles.title} numberOfLines={2}>
            {invite.title?.trim() || t('studioInvite.untitled')}
          </Text>
        </View>
      </View>

      {!!invite.note && <Text style={styles.note}>{invite.note}</Text>}

      {ended ? (
        <View style={styles.endedRow}>
          <Ionicons name="close-circle-outline" size={15} color={colors.textTertiary} />
          <Text style={styles.endedText}>{t('studioInvite.ended')}</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity
            style={[styles.btn, busy && styles.btnBusy]}
            onPress={join}
            disabled={busy}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name={isOwn ? 'enter-outline' : 'headset'} size={16} color="#fff" />
                <Text style={styles.btnText}>{isOwn ? t('studioInvite.reopen') : t('studioInvite.join')}</Text>
              </>
            )}
          </TouchableOpacity>
          {failed && <Text style={styles.failed}>{t('studioInvite.failed')}</Text>}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  card: {
    maxWidth: 280, minWidth: 220,
    backgroundColor: colors.surfaceLight,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
    gap: SPACING.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  cardOwn: { borderColor: colors.primary + '55' },
  cardOther: {},

  head: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  icon: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headText: { flex: 1 },
  kicker: { fontSize: 11, fontWeight: '800', color: colors.primary, letterSpacing: 0.4, textTransform: 'uppercase' },
  title: { fontSize: 14, fontWeight: '700', color: colors.text, marginTop: 1 },

  note: { fontSize: 13, color: colors.textSecondary, lineHeight: 18 },

  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, borderRadius: RADIUS.md, height: 38,
  },
  btnBusy: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  failed: { fontSize: 12, color: colors.error, textAlign: 'center' },

  endedRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 6 },
  endedText: { fontSize: 13, color: colors.textTertiary, fontWeight: '600' },
});
