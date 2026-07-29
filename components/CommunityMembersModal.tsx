import { useCallback, useEffect, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator, Alert, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import BadgeEmblem from './BadgeEmblem';
import RoleBadge from './RoleBadge';
import { ListRowsSkeleton } from './Skeleton';
import {
  fetchCommunityMembers, setMemberRole, moderateMember,
  type CommunityMember, type CommunityRole,
} from '../lib/communities';

type Props = {
  visible: boolean;
  onClose: () => void;
  communityId: string;
  callerRole: CommunityRole;
  currentUserId: string | null;
  onChanged?: () => void;       // a roster/role change happened (refresh the parent)
};

// Owner/manager member management + direct moderation. The vote-to-ban governance
// is a later phase; here owners act on anyone, managers act on plain members.
export default function CommunityMembersModal({
  visible, onClose, communityId, callerRole, currentUserId, onChanged,
}: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [members, setMembers] = useState<CommunityMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<CommunityMember | null>(null); // open action sheet
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMembers(await fetchCommunityMembers(communityId));
    setLoading(false);
  }, [communityId]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  function canActOn(m: CommunityMember): boolean {
    if (m.user_id === currentUserId) return false;
    if (callerRole === 'owner') return true;
    if (callerRole === 'manager') return m.role === 'member';
    return false;
  }

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    setTarget(null);
    if (!res.ok && res.error) { Alert.alert(t('communities.manageMembers'), t(res.error)); return; }
    await load();
    onChanged?.();
  }

  function promote(m: CommunityMember) { run(() => setMemberRole(communityId, m.user_id, 'manager')); }
  function demote(m: CommunityMember)  { run(() => setMemberRole(communityId, m.user_id, 'member')); }
  function transfer(m: CommunityMember) {
    Alert.alert(
      t('communities.transferTitle'),
      t('communities.transferBody', { name: m.profile?.display_name ?? m.profile?.username ?? '' }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('communities.transfer'), style: 'destructive', onPress: () => run(() => setMemberRole(communityId, m.user_id, 'owner')) },
      ],
    );
  }
  function ban(m: CommunityMember)    { run(() => moderateMember(communityId, m.user_id, 'ban')); }
  function unban(m: CommunityMember)  { run(() => moderateMember(communityId, m.user_id, 'unban')); }
  function unmute(m: CommunityMember) { run(() => moderateMember(communityId, m.user_id, 'unmute')); }
  function remove(m: CommunityMember) { run(() => moderateMember(communityId, m.user_id, 'remove')); }
  function mute(m: CommunityMember) {
    Alert.alert(t('communities.muteDurationTitle'), undefined, [
      { text: t('communities.mute1h'),  onPress: () => run(() => moderateMember(communityId, m.user_id, 'mute', 60)) },
      { text: t('communities.mute24h'), onPress: () => run(() => moderateMember(communityId, m.user_id, 'mute', 60 * 24)) },
      { text: t('communities.mute7d'),  onPress: () => run(() => moderateMember(communityId, m.user_id, 'mute', 60 * 24 * 7)) },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }

  const isMuted = (m: CommunityMember) => !!m.muted_until && new Date(m.muted_until).getTime() > Date.now();

  function statusPill(m: CommunityMember) {
    if (m.status === 'banned') return <Text style={[styles.pill, styles.pillBan]}>{t('communities.banned')}</Text>;
    if (m.status === 'invited') return <Text style={[styles.pill, styles.pillInvited]}>{t('communities.invited')}</Text>;
    if (isMuted(m)) return <Text style={[styles.pill, styles.pillMuted]}>{t('communities.muted')}</Text>;
    return null;
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>{t('communities.manageMembers')}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.close')}><Ionicons name="close" size={22} color={colors.textSecondary} /></TouchableOpacity>
          </View>

          {loading ? (
            <View style={{ maxHeight: 460, paddingVertical: SPACING.sm }}>
              <ListRowsSkeleton rows={6} trailing={false} />
            </View>
          ) : (
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingBottom: SPACING.lg }}>
              {members.map((m) => (
                <View key={m.user_id} style={styles.memberRow}>
                  {m.profile?.avatar_url ? (
                    <Image source={{ uri: m.profile.avatar_url }} style={styles.avatar} />
                  ) : (
                    <LinearGradient colors={GRADIENTS.primary} style={styles.avatar}>
                      <Text style={styles.avatarInitial}>{(m.profile?.display_name ?? '?').charAt(0).toUpperCase()}</Text>
                    </LinearGradient>
                  )}
                  <View style={styles.memberInfo}>
                    <View style={styles.nameLine}>
                      <Text style={styles.memberName} numberOfLines={1}>{m.profile?.display_name ?? m.profile?.username ?? '—'}</Text>
                      <BadgeEmblem profile={m.profile} size={12} />
                    </View>
                    <View style={styles.metaLine}>
                      {m.status === 'active' && <RoleBadge role={m.role} size={10} />}
                      {statusPill(m)}
                    </View>
                  </View>
                  {canActOn(m) && (
                    <TouchableOpacity onPress={() => setTarget(m)} hitSlop={8} style={styles.manageBtn}>
                      <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSecondary} />
                    </TouchableOpacity>
                  )}
                </View>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>

      {/* Per-member action sheet */}
      <Modal visible={!!target} transparent animationType="fade" onRequestClose={() => setTarget(null)}>
        <Pressable style={styles.backdrop} onPress={() => setTarget(null)}>
          <Pressable style={styles.actionSheet} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.actionName}>{target?.profile?.display_name ?? target?.profile?.username}</Text>
            {busy && <ActivityIndicator color={colors.primary} style={{ marginVertical: SPACING.sm }} />}

            {target && !busy && (
              <>
                {/* Owner-only role controls */}
                {callerRole === 'owner' && target.status === 'active' && target.role === 'member' && (
                  <Action icon="shield-checkmark" label={t('communities.promote')} onPress={() => promote(target)} />
                )}
                {callerRole === 'owner' && target.status === 'active' && target.role === 'manager' && (
                  <Action icon="person" label={t('communities.demote')} onPress={() => demote(target)} />
                )}
                {callerRole === 'owner' && target.status === 'active' && (
                  <Action icon="diamond" label={t('communities.transfer')} onPress={() => transfer(target)} />
                )}

                {/* Moderation (owner + manager) */}
                {target.status === 'active' && !isMuted(target) && (
                  <Action icon="volume-mute" label={t('communities.mute')} onPress={() => mute(target)} />
                )}
                {target.status === 'active' && isMuted(target) && (
                  <Action icon="volume-high" label={t('communities.unmute')} onPress={() => unmute(target)} />
                )}
                {target.status !== 'banned' && (
                  <Action icon="ban" label={t('communities.ban')} destructive onPress={() => ban(target)} />
                )}
                {target.status === 'banned' && (
                  <Action icon="checkmark-circle" label={t('communities.unban')} onPress={() => unban(target)} />
                )}
                <Action icon="person-remove" label={t('communities.removeMember')} destructive onPress={() => remove(target)} />
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </Modal>
  );
}

function Action({ icon, label, onPress, destructive }: {
  icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; destructive?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const color = destructive ? colors.error : colors.text;
  return (
    <TouchableOpacity style={styles.action} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: SPACING.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },

  memberRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingVertical: SPACING.sm },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceElevated },
  avatarInitial: { color: '#fff', fontSize: 16, fontWeight: '700' },
  memberInfo: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  memberName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  manageBtn: { padding: 4 },
  pill: { fontSize: 10, fontWeight: '800', overflow: 'hidden', borderRadius: RADIUS.full, paddingHorizontal: 7, paddingVertical: 2 },
  pillBan: { color: colors.error, backgroundColor: colors.error + '1A' },
  pillInvited: { color: colors.textSecondary, backgroundColor: colors.surfaceElevated },
  pillMuted: { color: colors.primary, backgroundColor: colors.primary + '1A' },

  actionSheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: SPACING.md, paddingTop: SPACING.sm, paddingBottom: SPACING.xl,
  },
  actionName: { color: colors.textSecondary, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: SPACING.sm },
  action: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.md, paddingHorizontal: SPACING.sm },
  actionLabel: { fontSize: 15, fontWeight: '600' },
});
