import * as ImagePicker from 'expo-image-picker';
import {
  View, Text, StyleSheet, TextInput,
  TouchableOpacity, ActivityIndicator, ScrollView, Alert, Image,
} from 'react-native';
import { useState, useEffect } from 'react';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../lib/supabase';
import { useProfile } from '../contexts/ProfileContext';
import { resolveRingColors, chosenTier } from '../lib/badges';
import { TEMPLATE_META, isLayoutTemplate } from '../lib/pageLayout';
import { GENDER_OPTIONS, genderLabel, ageFromDob } from '../lib/profileOptions';
import { loadOwnPhone, saveOwnPhone, upsertOwnIdentifiers } from '../lib/identifiers';
import { SPACING, RADIUS, GRADIENTS, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { removePublicUrls } from '../lib/storageCleanup';

export default function EditProfileScreen() {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const router = useRouter();
  const { profile: liveProfile, update } = useProfile();
  // The avatar glow + camera button take the user's emblem-theme color (their
  // tier ring gradient, honoring the selected theme) instead of a fixed brand orange.
  const accentTier = chosenTier(liveProfile);
  const accentGrad = accentTier ? resolveRingColors(liveProfile, accentTier) : GRADIENTS.primary;
  const accent = accentGrad[0]; // single color for the glow
  // Sub-label on the Page Layout button — the active template, or the default grid.
  const pageLayoutLabel = isLayoutTemplate(liveProfile?.page_layout)
    ? TEMPLATE_META[liveProfile!.page_layout as keyof typeof TEMPLATE_META].label
    : t('editProfile.standardGrid');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [link, setLink] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [phone, setPhone] = useState(''); // device-only plaintext; only a hash is uploaded
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [age, setAge] = useState<number | null>(null); // read-only, derived from dob

  useEffect(() => { fetchProfile(); }, []);

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    setUserEmail(user.email ?? null);
    // select('*') so pre-migration installs (no link/gender columns) don't error.
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (data) {
      setDisplayName(data.display_name || ''); setUsername(data.username || ''); setBio(data.bio || '');
      setAvatarUrl(data.avatar_url || null); setLink(data.link || ''); setGender(data.gender || null);
      // Age is read-only here — recomputed from the date of birth captured at
      // onboarding (falls back to the stored age column for older accounts).
      setAge(
        data.dob ? ageFromDob(new Date(data.dob))
          : typeof data.age === 'number' ? data.age
          : null,
      );
    }
    setPhone(await loadOwnPhone()); // plaintext lives on-device only
    setLoading(false);
  }

  async function handleChangePhoto() {
    const oldAvatar = avatarUrl; // remove this once the new one is saved
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as any, allowsEditing: true, aspect: [1, 1], quality: 0.8,
    });
    if (result.canceled || !result.assets[0]) return;

    setUploadingPhoto(true);
    const file = result.assets[0];
    const fileExt = file.uri.split('.').pop();
    const filePath = `${userId}/${Date.now()}.${fileExt}`;
    const formData = new FormData();
    formData.append('file', { uri: file.uri, name: `${Date.now()}.${fileExt}`, type: file.mimeType || 'image/jpeg' } as any);

    const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, formData, { contentType: file.mimeType || 'image/jpeg', upsert: true });
    if (uploadError) { Alert.alert(t('editProfile.error'), uploadError.message); setUploadingPhoto(false); return; }

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath);
    const { error: updateError } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', userId);
    if (!updateError) {
      setAvatarUrl(publicUrl);
      update({ avatar_url: publicUrl }); // propagate to every screen showing the avatar
      // Delete the previous avatar object so old photos don't linger publicly.
      if (oldAvatar && oldAvatar !== publicUrl) removePublicUrls([oldAvatar]);
    }
    setUploadingPhoto(false);
  }

  async function handleSave() {
    if (!displayName.trim() || !username.trim()) { Alert.alert(t('editProfile.error'), t('editProfile.errRequired')); return; }
    if (username.trim().length < 5) { Alert.alert(t('editProfile.error'), t('editProfile.errUsernameMin')); return; }
    if (username.trim().length > 30) { Alert.alert(t('editProfile.error'), t('editProfile.errUsernameMax')); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { Alert.alert(t('editProfile.error'), t('editProfile.errUsernameChars')); return; }
    setSaving(true);
    const core = { display_name: displayName.trim(), username: username.trim().toLowerCase(), bio: bio.trim() };
    const { error } = await supabase.from('profiles').update(core).eq('id', userId);
    if (error) {
      Alert.alert(t('editProfile.error'), error.message.includes('unique') ? t('editProfile.errUsernameTaken') : error.message);
      setSaving(false); return;
    }
    // Link + gender go in a separate update so a pre-migration column gap can't
    // fail the whole save — best-effort, persists once profile_fields.sql is applied.
    const extra = { link: link.trim() || null, gender: gender || null };
    const { error: extraErr } = await supabase.from('profiles').update(extra).eq('id', userId);
    update({ ...core, ...(extraErr ? {} : extra) }); // keep the global profile in sync
    // Phone: plaintext stays on this device; only a salted hash is uploaded so
    // contacts who have this number can discover the account. '' clears the hash.
    await saveOwnPhone(phone);
    upsertOwnIdentifiers(userId!, userEmail, phone.trim() ? phone : '');
    Alert.alert(t('editProfile.savedTitle'), t('editProfile.savedBody'), [{ text: t('editProfile.ok'), onPress: () => router.back() }]);
    setSaving(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.inner}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.cancelBtn}>{t('common.cancel')}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profile.editProfile')}</Text>
        <TouchableOpacity onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.primary} size="small" /> : <Text style={styles.saveBtn}>{t('editProfile.save')}</Text>}
        </TouchableOpacity>
      </View>

      {/* Avatar */}
      <View style={styles.avatarSection}>
        <TouchableOpacity style={[styles.avatarWrap, { shadowColor: accent }]} onPress={handleChangePhoto} disabled={uploadingPhoto}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>{displayName?.charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
          <LinearGradient colors={accentGrad as any} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cameraOverlay}>
            {uploadingPhoto ? (
              <ActivityIndicator color={colors.text} size="small" />
            ) : (
              <Ionicons name="camera" size={18} color={colors.text} />
            )}
          </LinearGradient>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleChangePhoto} disabled={uploadingPhoto}>
          {/* Tinted by the user's displayed badge tier (same accent as the glow
              + camera button); brand orange before any badge is shown. */}
          <Text style={[styles.changePhotoText, { color: accent }]}>
            {uploadingPhoto ? t('editProfile.uploading') : t('editProfile.changePhoto')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Form */}
      <View style={styles.form}>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.displayName')}</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder={t('editProfile.displayNamePlaceholder')}
            placeholderTextColor={colors.textTertiary}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.username')}</Text>
          <View style={styles.usernameRow}>
            <Text style={styles.atSign}>@</Text>
            <TextInput
              style={styles.usernameInput}
              value={username}
              onChangeText={setUsername}
              placeholder={t('editProfile.usernamePlaceholder')}
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="none"
              maxLength={30}
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.bio')}</Text>
          <TextInput
            style={styles.bioInput}
            value={bio}
            onChangeText={setBio}
            placeholder={t('editProfile.bioPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            multiline
            maxLength={150}
          />
          <Text style={styles.charCount}>{bio.length}/150</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.link')}</Text>
          <TextInput
            style={styles.input}
            value={link}
            onChangeText={setLink}
            placeholder={t('editProfile.linkPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.fieldHint}>{t('editProfile.linkHint')}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.phone')}</Text>
          <TextInput
            style={styles.input}
            value={phone}
            onChangeText={setPhone}
            placeholder={t('editProfile.phonePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            keyboardType="phone-pad"
            autoCorrect={false}
          />
          <Text style={styles.fieldHint}>{t('editProfile.phoneHint')}</Text>
        </View>

        {/* Badges + Page Layout — square buttons side by side, above Gender */}
        <View style={styles.squareRow}>
          <TouchableOpacity style={styles.squareBtn} activeOpacity={0.85} onPress={() => router.push('/badges')}>
            <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.squareIcon}>
              <Ionicons name="ribbon" size={28} color="#fff" />
            </LinearGradient>
            <Text style={styles.squareLabel}>{t('editProfile.badges')}</Text>
            <Text style={styles.squareSub}>{t('editProfile.badgesSub')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.squareBtn}
            activeOpacity={0.85}
            onPress={() => router.push('/page-layout')}
          >
            <LinearGradient colors={GRADIENTS.primary} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.squareIcon}>
              <Ionicons name="color-palette" size={28} color="#fff" />
            </LinearGradient>
            <Text style={styles.squareLabel}>{t('editProfile.pageLayout')}</Text>
            <Text style={styles.squareSub}>{pageLayoutLabel}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('onboarding.gender')}</Text>
          <View style={styles.genderRow}>
            {GENDER_OPTIONS.map(opt => {
              const active = gender === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.genderChip, active && styles.genderChipActive]}
                  onPress={() => setGender(active ? null : opt)}
                >
                  <Text style={[styles.genderChipText, active && styles.genderChipTextActive]}>{genderLabel(opt)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.fieldHint}>{t('editProfile.genderHint')}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t('editProfile.age')}</Text>
          <View style={styles.readonlyBox}>
            <Text style={styles.readonlyValue}>{age != null ? `${age}` : t('editProfile.notSet')}</Text>
          </View>
          <Text style={styles.fieldHint}>{t('editProfile.ageHint')}</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingContainer: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' },
  inner: { paddingBottom: SPACING.xxl },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: colors.border,
  },
  cancelBtn: { color: colors.textSecondary, fontSize: 15, fontWeight: '500' },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  saveBtn: { color: colors.primary, fontSize: 15, fontWeight: '800' },

  avatarSection: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.md },
  avatarWrap: {
    position: 'relative',
    shadowColor: colors.primary, shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  avatarImage: { width: 100, height: 100, borderRadius: RADIUS.full, borderWidth: 2, borderColor: colors.border },
  avatarPlaceholder: { width: 100, height: 100, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.text, fontSize: 40, fontWeight: '800' },
  cameraOverlay: {
    position: 'absolute', bottom: 2, right: 2,
    width: 32, height: 32, borderRadius: RADIUS.full,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: colors.background,
  },
  changePhotoText: { color: colors.primary, fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },

  form: { paddingHorizontal: SPACING.md, gap: SPACING.lg + 2 },
  field: { gap: 8 },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: 14,
    color: colors.text, fontSize: 16,
  },
  usernameRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md,
  },
  atSign: { color: colors.textSecondary, fontSize: 16, fontWeight: '600' },
  usernameInput: { flex: 1, paddingVertical: 14, color: colors.text, fontSize: 16 },
  bioInput: {
    backgroundColor: colors.surfaceLight, borderWidth: 1, borderColor: colors.border,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md, paddingBottom: SPACING.lg,
    color: colors.text, fontSize: 16, lineHeight: 22, minHeight: 110, textAlignVertical: 'top',
  },
  // Floated into the input's corner so it doesn't add a line of flow height —
  // keeps Bio↔Link spacing even with Display Name↔Username.
  charCount: { position: 'absolute', bottom: 10, right: 14, color: colors.textTertiary, fontSize: 12, fontWeight: '500' },
  fieldHint: { color: colors.textTertiary, fontSize: 12, lineHeight: 17 },
  // Read-only display box (e.g. Age) — dimmer surface + muted text so it reads
  // as non-editable next to the real inputs.
  readonlyBox: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderSubtle,
    borderRadius: RADIUS.lg, paddingHorizontal: SPACING.md, paddingVertical: 14,
  },
  readonlyValue: { color: colors.textSecondary, fontSize: 16 },

  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genderChip: {
    paddingVertical: SPACING.sm + 1, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceLight,
  },
  genderChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '1A' },
  genderChipText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600' },
  genderChipTextActive: { color: colors.primaryLight, fontWeight: '700' },

  squareRow: { flexDirection: 'row', gap: SPACING.md },
  squareBtn: {
    flex: 1, aspectRatio: 1,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.md,
  },
  squareIcon: {
    width: 56, height: 56, borderRadius: RADIUS.lg,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  squareLabel: { color: colors.text, fontSize: 15, fontWeight: '700', letterSpacing: -0.1 },
  squareSub: { color: colors.textSecondary, fontSize: 12, textAlign: 'center' },
  soonPill: {
    backgroundColor: colors.primary + '1A', borderWidth: 1, borderColor: colors.primary + '3A',
    borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 3,
  },
  soonText: { color: colors.primaryLight, fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
});
