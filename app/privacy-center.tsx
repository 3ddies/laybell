import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch, Alert, Platform, Share, ActivityIndicator,
} from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import SwipeBackPager from '../components/SwipeBackPager';
import { useProfile } from '../contexts/ProfileContext';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { SPACING, RADIUS, type ThemePalette } from '../constants/theme';
import { isAdPersonalizationEnabled, setAdPersonalization } from '../lib/adPrefs';
import { buildDataExport } from '../lib/dataExport';
import { confirmDeleteAccount } from '../lib/accountDeletion';

function Sep() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.sep} />;
}

function Row({ icon, label, subtitle, onPress, destructive, loading }: {
  icon: any; label: string; subtitle?: string; onPress?: () => void; destructive?: boolean; loading?: boolean;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7} disabled={loading}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={22} color={destructive ? colors.error : colors.text} /></View>
      <View style={styles.rowContent}>
        <Text style={[styles.rowLabel, destructive && { color: colors.error }]}>{label}</Text>
        {!!subtitle && <Text style={styles.rowSub}>{subtitle}</Text>}
      </View>
      {loading
        ? <ActivityIndicator color={colors.primary} />
        : <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />}
    </TouchableOpacity>
  );
}

function ToggleRow({ icon, label, subtitle, value, onValueChange }: {
  icon: any; label: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={22} color={colors.text} /></View>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{label}</Text>
        {!!subtitle && <Text style={styles.rowSub}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.primary + '88' }}
        thumbColor={value ? colors.primary : colors.textTertiary}
      />
    </View>
  );
}

// In-app privacy & data-rights hub. Gives users the controls our Privacy Policy
// promises: read the policies, control ad personalization, download a copy of
// their data, see parental-consent status, and delete their account.
export default function PrivacyCenterScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { profile } = useProfile();
  const [adsOn, setAdsOn] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEffect(() => { isAdPersonalizationEnabled().then(setAdsOn); }, []);

  async function handleExport() {
    try {
      setExporting(true);
      const json = await buildDataExport();
      const fileUri = (FileSystem.cacheDirectory ?? '') + 'laybell-data-export.json';
      await FileSystem.writeAsStringAsync(fileUri, json);
      // iOS shares the file; Android shares the JSON text (no extra native dep).
      await Share.share(Platform.OS === 'ios' ? { url: fileUri } : { message: json });
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Please try again.');
    } finally {
      setExporting(false);
    }
  }

  const isMinor = !!(profile as any)?.is_minor;
  const consentVerified = !!(profile as any)?.parent_consent_verified;

  return (
    <SwipeBackPager>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={24} color={colors.primary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Privacy & Data</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={styles.intro}>
            Manage your privacy, control how your data is used, get a copy of it, or delete your account.
          </Text>

          <View style={styles.card}>
            <Row icon="document-text-outline" label="Privacy Policy" onPress={() => router.push('/privacy-policy')} />
            <Sep />
            <Row icon="shield-outline" label="Terms of Service" onPress={() => router.push('/terms-of-service')} />
          </View>

          <Text style={styles.section}>Your data & rights</Text>
          <View style={styles.card}>
            <ToggleRow
              icon="sparkles-outline"
              label="Personalized ads"
              subtitle="Use my profile & activity to tailor ads. Off by default."
              value={adsOn}
              onValueChange={(v) => { setAdsOn(v); setAdPersonalization(v); }}
            />
            <Sep />
            <Row
              icon="download-outline"
              label="Download your data"
              subtitle="Export a copy of your account data"
              onPress={handleExport}
              loading={exporting}
            />
          </View>

          {isMinor && (
            <View style={[styles.card, { marginTop: SPACING.md }]}>
              <View style={styles.statusRow}>
                <Ionicons
                  name={consentVerified ? 'checkmark-circle' : 'time-outline'}
                  size={20}
                  color={consentVerified ? colors.success : colors.primary}
                />
                <Text style={styles.statusText}>
                  {consentVerified
                    ? 'Parent/guardian consent confirmed.'
                    : 'Parent/guardian consent recorded — awaiting email confirmation.'}
                </Text>
              </View>
            </View>
          )}

          <Text style={styles.section}>Danger zone</Text>
          <View style={styles.card}>
            <Row
              icon="trash-outline"
              label="Delete your account"
              subtitle="Hide for 3 months or delete now"
              destructive
              onPress={() => confirmDeleteAccount()}
            />
          </View>

          <Text style={styles.foot}>Questions about your data? Contact privacy@laybell.app</Text>
        </ScrollView>
      </View>
    </SwipeBackPager>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.borderSubtle,
  },
  backBtn: { width: 40, height: 40, alignItems: 'flex-start', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  content: { padding: SPACING.md, paddingBottom: SPACING.xxl, gap: SPACING.sm },
  intro: { color: c.textSecondary, fontSize: 14, lineHeight: 20, marginBottom: SPACING.sm },
  section: { color: c.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: SPACING.lg, marginBottom: SPACING.xs, marginLeft: SPACING.xs },
  card: { backgroundColor: c.surfaceLight, borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: 56 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.sm + 4, paddingHorizontal: SPACING.md },
  rowIcon: { width: 28 },
  rowContent: { flex: 1, paddingRight: SPACING.sm },
  rowLabel: { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: c.textSecondary, fontSize: 12, marginTop: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, padding: SPACING.md },
  statusText: { flex: 1, color: c.textSecondary, fontSize: 13, lineHeight: 19 },
  foot: { color: c.textTertiary, fontSize: 12, textAlign: 'center', marginTop: SPACING.lg },
});
