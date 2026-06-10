import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Switch, Alert,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState, useRef, useCallback } from 'react';
import PagerView from 'react-native-pager-view';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import {
  getCameraPermission, getMicrophonePermission, getPhotosPermission,
  getNotificationsPermission, getLocationPermission, getContactsPermission,
  requestCameraPermission, requestMicrophonePermission, requestPhotosPermission,
  requestNotificationsPermission, openAppSettings, type PermInfo,
} from '../lib/permissions';
import { captureAndSaveLocation, disableLocation } from '../lib/location';
import { requestContactsPermission } from '../lib/contacts';
import { COLORS, SPACING, RADIUS } from '../constants/theme';

const UNKNOWN: PermInfo = { granted: false, canAskAgain: true, status: 'undetermined' };

function statusText(s: PermInfo): { label: string; color: string } {
  if (s.granted) return { label: 'Allowed', color: COLORS.success };
  if (s.status === 'undetermined') return { label: 'Tap to allow', color: COLORS.primary };
  return { label: 'Denied', color: COLORS.error };
}

export default function PermissionsScreen() {
  const router = useRouter();
  const { profile, update } = useProfile();
  const pagerRef = useRef<PagerView>(null);

  const [s, setS] = useState<Record<string, PermInfo>>({
    camera: UNKNOWN, microphone: UNKNOWN, photos: UNKNOWN,
    notifications: UNKNOWN, location: UNKNOWN, contacts: UNKNOWN,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const refreshStatuses = useCallback(async () => {
    const [camera, microphone, photos, notifications, location, contacts] = await Promise.all([
      getCameraPermission(), getMicrophonePermission(), getPhotosPermission(),
      getNotificationsPermission(), getLocationPermission(), getContactsPermission(),
    ]);
    setS({ camera, microphone, photos, notifications, location, contacts });
  }, []);

  useEffect(() => { refreshStatuses(); }, [refreshStatuses]);

  // OS-only permissions: request when first asked, otherwise deep-link to Settings.
  async function handleOsRow(key: string, request: () => Promise<PermInfo>) {
    const cur = s[key];
    if (cur.status === 'undetermined') {
      const next = await request();
      setS(prev => ({ ...prev, [key]: next }));
      if (!next.granted && !next.canAskAgain) promptOpenSettings();
    } else {
      openAppSettings();
    }
  }

  function promptOpenSettings() {
    Alert.alert(
      'Permission needed',
      'Enable this in your device Settings for Laybell to use it.',
      [{ text: 'Not now', style: 'cancel' }, { text: 'Open Settings', onPress: openAppSettings }],
    );
  }

  // Location: an app-level toggle that also drives the OS permission + capture.
  async function toggleLocation(value: boolean) {
    if (!profile?.id || busy) return;
    setBusy('location');
    if (value) {
      const saved = await captureAndSaveLocation(profile.id);
      if (saved) update({ location_enabled: true, city: saved.city } as any);
      else { const st = await getLocationPermission(); if (!st.canAskAgain) promptOpenSettings(); }
    } else {
      await disableLocation(profile.id);
      update({ location_enabled: false } as any);
    }
    await refreshStatuses();
    setBusy(null);
  }

  // Contacts: app-level toggle. Suggestions read the address book live when on, so
  // here we only confirm the OS permission and persist the preference.
  async function toggleContacts(value: boolean) {
    if (!profile?.id || busy) return;
    setBusy('contacts');
    if (value) {
      const perm = await requestContactsPermission();
      if (perm.granted) {
        await supabase.from('profiles').update({ contacts_enabled: true }).eq('id', profile.id);
        update({ contacts_enabled: true } as any);
      } else if (!perm.canAskAgain) {
        promptOpenSettings();
      }
    } else {
      await supabase.from('profiles').update({ contacts_enabled: false }).eq('id', profile.id);
      update({ contacts_enabled: false } as any);
    }
    await refreshStatuses();
    setBusy(null);
  }

  const locationOn = !!profile?.location_enabled && s.location.granted;
  const contactsOn = !!profile?.contacts_enabled && s.contacts.granted;

  const deviceRows: { key: string; icon: any; label: string; sub: string; request: () => Promise<PermInfo> }[] = [
    { key: 'camera', icon: 'camera-outline', label: 'Camera', sub: 'Capture stories and posts', request: requestCameraPermission },
    { key: 'photos', icon: 'image-outline', label: 'Photos', sub: 'Choose photos and videos to post', request: requestPhotosPermission },
    { key: 'microphone', icon: 'mic-outline', label: 'Microphone', sub: 'Record audio and video', request: requestMicrophonePermission },
    { key: 'notifications', icon: 'notifications-outline', label: 'Notifications', sub: 'Likes, comments, follows & messages', request: requestNotificationsPermission },
  ];

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ gestureEnabled: false }} />
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Permissions</Text>
        <View style={{ width: 40 }} />
      </View>

      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={1}
        onPageSelected={(e) => {
          if (e.nativeEvent.position === 0) {
            if (router.canGoBack()) router.back();
            else pagerRef.current?.setPageWithoutAnimation(1);
          }
        }}
      >
        <View key="dismiss" style={styles.dismissPage} />
        <View key="content" style={styles.page}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.intro}>
              Control what Laybell can access. Location and contacts are only used to suggest people you may know — never shared on your profile.
            </Text>

            {/* Recommendation signals — real app-level toggles */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recommendations</Text>
              <View style={styles.sectionCard}>
                <View style={styles.row}>
                  <View style={styles.rowIcon}><Ionicons name="location-outline" size={18} color={COLORS.primary} /></View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>Location</Text>
                    <Text style={styles.rowSubtitle}>
                      Suggest people in your area{profile?.city ? ` · ${profile.city}` : ''}
                    </Text>
                  </View>
                  <Switch
                    value={locationOn}
                    onValueChange={toggleLocation}
                    disabled={busy === 'location'}
                    trackColor={{ false: COLORS.border, true: COLORS.primary + '88' }}
                    thumbColor={locationOn ? COLORS.primary : COLORS.textTertiary}
                  />
                </View>
                <View style={styles.separator} />
                <View style={styles.row}>
                  <View style={styles.rowIcon}><Ionicons name="people-outline" size={18} color={COLORS.primary} /></View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>Contacts</Text>
                    <Text style={styles.rowSubtitle}>Find contacts who are on Laybell</Text>
                  </View>
                  <Switch
                    value={contactsOn}
                    onValueChange={toggleContacts}
                    disabled={busy === 'contacts'}
                    trackColor={{ false: COLORS.border, true: COLORS.primary + '88' }}
                    thumbColor={contactsOn ? COLORS.primary : COLORS.textTertiary}
                  />
                </View>
              </View>
            </View>

            {/* Device access — status + deep-link to OS settings */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Device access</Text>
              <View style={styles.sectionCard}>
                {deviceRows.map((r, i) => {
                  const st = statusText(s[r.key]);
                  return (
                    <View key={r.key}>
                      <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => handleOsRow(r.key, r.request)}>
                        <View style={styles.rowIcon}><Ionicons name={r.icon} size={18} color={COLORS.primary} /></View>
                        <View style={styles.rowContent}>
                          <Text style={styles.rowLabel}>{r.label}</Text>
                          <Text style={styles.rowSubtitle}>{r.sub}</Text>
                        </View>
                        <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
                        <Ionicons name="chevron-forward" size={16} color={COLORS.textTertiary} />
                      </TouchableOpacity>
                      {i < deviceRows.length - 1 && <View style={styles.separator} />}
                    </View>
                  );
                })}
              </View>
              <Text style={styles.hint}>Tap a row to allow it, or to open your device Settings if it was previously denied.</Text>
            </View>
          </ScrollView>
        </View>
      </PagerView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.sm, paddingTop: SPACING.xxl + SPACING.sm, paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: SPACING.sm },
  headerTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800' },

  pager: { flex: 1 },
  page: { flex: 1 },
  dismissPage: { flex: 1, backgroundColor: COLORS.background },
  content: { padding: SPACING.md, gap: SPACING.md, paddingBottom: SPACING.xxl },
  intro: { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19, paddingHorizontal: SPACING.xs },

  section: { gap: SPACING.xs },
  sectionTitle: {
    color: COLORS.textTertiary, fontSize: 11, fontWeight: '700',
    textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.xs,
  },
  sectionCard: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', padding: SPACING.md, gap: SPACING.md },
  rowIcon: {
    width: 32, height: 32, borderRadius: RADIUS.sm,
    backgroundColor: COLORS.primary + '18', alignItems: 'center', justifyContent: 'center',
  },
  rowContent: { flex: 1 },
  rowLabel: { color: COLORS.text, fontSize: 15 },
  rowSubtitle: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },
  statusText: { fontSize: 12, fontWeight: '700' },
  separator: { height: 0.5, backgroundColor: COLORS.border, marginLeft: SPACING.md + 32 + SPACING.md },
  hint: { color: COLORS.textTertiary, fontSize: 12, paddingHorizontal: SPACING.xs, lineHeight: 17 },
});
