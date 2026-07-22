import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Image, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles } from './ThemeContext';
import { useTranslation } from './LanguageContext';
import { useLinkGuard } from './LinkGuardContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { adDestination, adFullMeta, recordAdClick, type AdPlacement } from '../lib/ads';

// One handler for EVERY ad CTA, so each objective lands somewhere specific
// without every ad surface (feed / reels / TV / music) re-implementing it:
//   awareness  → a Laybell profile (one profile → straight there; several →
//                a chooser sheet so the viewer picks which to visit)
//   engagement → the advertiser's shop
//   traffic / legacy → the external link, through the "leaving Laybell" guard.
// Triggered imperatively via openAdCta(item, placement, viewerId) — `item` is
// the same object the surface already passes to recordAdClick.

type CtaRequest = { item: any; placement: AdPlacement; viewerId: string | null };
type ChooserProfile = { id: string; username: string | null; display_name: string | null; avatar_url: string | null };

let handler: ((req: CtaRequest) => void) | null = null;
export function openAdCta(item: any, placement: AdPlacement, viewerId: string | null) {
  handler?.({ item, placement, viewerId });
}

export function AdCtaProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const linkGuard = useLinkGuard();

  // Profile chooser state (awareness ads pointing at several profiles).
  const [chooserOpen, setChooserOpen] = useState(false);
  const [profiles, setProfiles] = useState<ChooserProfile[] | null>(null);
  const advertiserRef = useRef<string>('');

  useEffect(() => {
    handler = (req) => {
      const dest = adDestination(req.item);
      if (!dest) return;
      const meta = adFullMeta(req.item);
      const record = () => recordAdClick(req.item, req.placement, req.viewerId);

      if (dest.kind === 'website') {
        linkGuard.open(dest.url, {
          context: 'ad',
          sourceName: meta?.advertiserName,
          onProceed: record,
        });
        return;
      }
      if (dest.kind === 'shop') {
        record();
        router.push(`/shop/${dest.ownerId}`);
        return;
      }
      // profile
      if (dest.ids.length === 1) {
        record();
        router.push(`/profile/${dest.ids[0]}`);
        return;
      }
      // Several profiles → let the viewer choose. Count the click now (the CTA
      // was tapped) and load the profile cards for the sheet.
      record();
      advertiserRef.current = meta?.advertiserName ?? '';
      setProfiles(null);
      setChooserOpen(true);
      supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .in('id', dest.ids)
        .then(({ data }) => {
          // Preserve the advertiser's chosen order.
          const byId = new Map((data ?? []).map((p) => [p.id, p as ChooserProfile]));
          setProfiles(dest.ids.map((id) => byId.get(id)).filter(Boolean) as ChooserProfile[]);
        });
    };
    return () => { handler = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickProfile(id: string) {
    setChooserOpen(false);
    router.push(`/profile/${id}`);
  }

  return (
    <>
      {children}
      <Modal visible={chooserOpen} transparent animationType="slide" onRequestClose={() => setChooserOpen(false)} statusBarTranslucent>
        <Pressable style={styles.backdrop} onPress={() => setChooserOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + SPACING.md }]}>
            <View style={styles.grab} />
            <Text style={styles.title}>{t('adCta.chooseProfileTitle')}</Text>
            {!!advertiserRef.current && <Text style={styles.sub} numberOfLines={1}>{advertiserRef.current}</Text>}
            {profiles === null ? (
              <ActivityIndicator color={colors.primary} style={{ paddingVertical: SPACING.lg }} />
            ) : (
              profiles.map((p) => {
                const name = p.display_name || p.username || t('adCta.aProfile');
                return (
                  <TouchableOpacity key={p.id} style={styles.row} onPress={() => pickProfile(p.id)} activeOpacity={0.8}>
                    {p.avatar_url ? (
                      <Image source={{ uri: p.avatar_url }} style={styles.avatar} />
                    ) : (
                      <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                        <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
                      </LinearGradient>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
                      {!!p.username && <Text style={styles.rowHandle} numberOfLines={1}>@{p.username}</Text>}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                  </TouchableOpacity>
                );
              })
            )}
            <TouchableOpacity style={styles.cancel} onPress={() => setChooserOpen(false)} activeOpacity={0.7}>
              <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: c.surfaceElevated,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderWidth: 1, borderColor: c.border,
    paddingHorizontal: SPACING.lg, paddingTop: SPACING.sm, gap: SPACING.xs,
  },
  grab: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.border, marginBottom: SPACING.sm },
  title: { color: c.text, fontSize: 16, fontWeight: '800' },
  sub: { color: c.textSecondary, fontSize: 12, marginBottom: SPACING.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.sm },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarInitial: { color: '#fff', fontSize: 18, fontWeight: '700' },
  rowName: { color: c.text, fontSize: 15, fontWeight: '700' },
  rowHandle: { color: c.textTertiary, fontSize: 12, marginTop: 1 },
  cancel: { alignItems: 'center', paddingVertical: SPACING.md, marginTop: SPACING.xs },
  cancelText: { color: c.textSecondary, fontSize: 15, fontWeight: '700' },
});
