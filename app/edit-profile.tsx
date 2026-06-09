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
import { GENDER_OPTIONS } from '../lib/profileOptions';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

export default function EditProfileScreen() {
  const router = useRouter();
  const { update } = useProfile();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [link, setLink] = useState('');
  const [gender, setGender] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => { fetchProfile(); }, []);

  async function fetchProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);
    // select('*') so pre-migration installs (no link/gender columns) don't error.
    const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
    if (data) {
      setDisplayName(data.display_name || ''); setUsername(data.username || ''); setBio(data.bio || '');
      setAvatarUrl(data.avatar_url || null); setLink(data.link || ''); setGender(data.gender || null);
    }
    setLoading(false);
  }

  async function handleChangePhoto() {
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
    if (uploadError) { Alert.alert('Error', uploadError.message); setUploadingPhoto(false); return; }

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath);
    const { error: updateError } = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', userId);
    if (!updateError) {
      setAvatarUrl(publicUrl);
      update({ avatar_url: publicUrl }); // propagate to every screen showing the avatar
    }
    setUploadingPhoto(false);
  }

  async function handleSave() {
    if (!displayName.trim() || !username.trim()) { Alert.alert('Error', 'Display name and username are required'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { Alert.alert('Error', 'Username can only contain letters, numbers, and underscores'); return; }
    setSaving(true);
    const core = { display_name: displayName.trim(), username: username.trim().toLowerCase(), bio: bio.trim() };
    const { error } = await supabase.from('profiles').update(core).eq('id', userId);
    if (error) {
      Alert.alert('Error', error.message.includes('unique') ? 'Username is already taken' : error.message);
      setSaving(false); return;
    }
    // Link + gender go in a separate update so a pre-migration column gap can't
    // fail the whole save — best-effort, persists once profile_fields.sql is applied.
    const extra = { link: link.trim() || null, gender: gender || null };
    const { error: extraErr } = await supabase.from('profiles').update(extra).eq('id', userId);
    update({ ...core, ...(extraErr ? {} : extra) }); // keep the global profile in sync
    Alert.alert('Saved!', 'Your profile has been updated', [{ text: 'OK', onPress: () => router.back() }]);
    setSaving(false);
  }

  if (loading) {
    return <View style={styles.loadingContainer}><ActivityIndicator color={COLORS.primary} size="large" /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.inner}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.cancelBtn}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <TouchableOpacity onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color={COLORS.primary} size="small" /> : <Text style={styles.saveBtn}>Save</Text>}
        </TouchableOpacity>
      </View>

      {/* Avatar */}
      <View style={styles.avatarSection}>
        <TouchableOpacity style={styles.avatarWrap} onPress={handleChangePhoto} disabled={uploadingPhoto}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
          ) : (
            <LinearGradient colors={GRADIENTS.primary} style={styles.avatarPlaceholder}>
              <Text style={styles.avatarText}>{displayName?.charAt(0).toUpperCase()}</Text>
            </LinearGradient>
          )}
          <View style={styles.cameraOverlay}>
            {uploadingPhoto ? (
              <ActivityIndicator color={COLORS.text} size="small" />
            ) : (
              <Ionicons name="camera" size={18} color={COLORS.text} />
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleChangePhoto} disabled={uploadingPhoto}>
          <Text style={styles.changePhotoText}>
            {uploadingPhoto ? 'Uploading...' : 'Change Profile Photo'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Form */}
      <View style={styles.form}>
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Display Name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your display name"
            placeholderTextColor={COLORS.textTertiary}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Username</Text>
          <View style={styles.usernameRow}>
            <Text style={styles.atSign}>@</Text>
            <TextInput
              style={styles.usernameInput}
              value={username}
              onChangeText={setUsername}
              placeholder="username"
              placeholderTextColor={COLORS.textTertiary}
              autoCapitalize="none"
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Bio</Text>
          <TextInput
            style={styles.bioInput}
            value={bio}
            onChangeText={setBio}
            placeholder="Tell the world about yourself..."
            placeholderTextColor={COLORS.textTertiary}
            multiline
            maxLength={150}
          />
          <Text style={styles.charCount}>{bio.length}/150</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Link</Text>
          <TextInput
            style={styles.input}
            value={link}
            onChangeText={setLink}
            placeholder="yourwebsite.com"
            placeholderTextColor={COLORS.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={styles.fieldHint}>Shown as a tappable link under your bio.</Text>
        </View>

        {/* Badges + Page Layout — square buttons side by side, above Gender */}
        <View style={styles.squareRow}>
          <TouchableOpacity style={styles.squareBtn} onPress={() => router.push('/badges')}>
            <View style={styles.squareIcon}><Ionicons name="ribbon-outline" size={26} color={COLORS.primary} /></View>
            <Text style={styles.squareLabel}>Badges</Text>
            <Text style={styles.squareSub}>Emblem & rewards</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.squareBtn}
            onPress={() => Alert.alert('Page Layout', 'Custom page layouts are coming soon — unlock different profile configurations as you earn higher badge tiers.')}
          >
            <View style={styles.squareIcon}><Ionicons name="grid-outline" size={26} color={COLORS.primary} /></View>
            <Text style={styles.squareLabel}>Page Layout</Text>
            <Text style={styles.squareSub}>Coming soon</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Gender</Text>
          <View style={styles.genderRow}>
            {GENDER_OPTIONS.map(opt => {
              const active = gender === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[styles.genderChip, active && styles.genderChipActive]}
                  onPress={() => setGender(active ? null : opt)}
                >
                  <Text style={[styles.genderChipText, active && styles.genderChipTextActive]}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.fieldHint}>Private — never shown on your public profile.</Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  loadingContainer: { flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center' },
  inner: { paddingBottom: SPACING.xxl },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.md,
    paddingTop: SPACING.xxl + SPACING.sm,
    paddingBottom: SPACING.md,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.border,
  },
  cancelBtn: { color: COLORS.textSecondary, fontSize: 15 },
  headerTitle: { color: COLORS.text, fontSize: 17, fontWeight: '700' },
  saveBtn: { color: COLORS.primary, fontSize: 15, fontWeight: '700' },

  avatarSection: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  avatarWrap: { position: 'relative' },
  avatarImage: { width: 96, height: 96, borderRadius: RADIUS.full },
  avatarPlaceholder: { width: 96, height: 96, borderRadius: RADIUS.full, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: COLORS.text, fontSize: 38, fontWeight: '700' },
  cameraOverlay: {
    position: 'absolute', bottom: 0, right: 0,
    width: 30, height: 30, borderRadius: RADIUS.full,
    backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: COLORS.background,
  },
  changePhotoText: { color: COLORS.primary, fontSize: 14, fontWeight: '600' },

  form: { paddingHorizontal: SPACING.md, gap: SPACING.lg },
  field: { gap: 6 },
  fieldLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: COLORS.text, fontSize: 15,
  },
  usernameRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
  },
  atSign: { color: COLORS.textSecondary, fontSize: 15 },
  usernameInput: { flex: 1, paddingVertical: SPACING.md, color: COLORS.text, fontSize: 15 },
  bioInput: {
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md,
    paddingTop: SPACING.md, paddingBottom: SPACING.lg,
    color: COLORS.text, fontSize: 15, minHeight: 100, textAlignVertical: 'top',
  },
  // Floated into the input's corner so it doesn't add a line of flow height —
  // keeps Bio↔Link spacing even with Display Name↔Username.
  charCount: { position: 'absolute', bottom: 8, right: 12, color: COLORS.textTertiary, fontSize: 12 },
  fieldHint: { color: COLORS.textTertiary, fontSize: 12 },

  genderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  genderChip: {
    paddingVertical: SPACING.sm, paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.full, borderWidth: 1, borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight,
  },
  genderChipActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '1A' },
  genderChipText: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '600' },
  genderChipTextActive: { color: COLORS.primaryLight },

  squareRow: { flexDirection: 'row', gap: SPACING.md },
  squareBtn: {
    flex: 1, aspectRatio: 1,
    backgroundColor: COLORS.surfaceLight, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.md,
  },
  squareIcon: {
    width: 52, height: 52, borderRadius: RADIUS.md,
    backgroundColor: COLORS.primary + '18', alignItems: 'center', justifyContent: 'center',
  },
  squareLabel: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  squareSub: { color: COLORS.textSecondary, fontSize: 12, textAlign: 'center' },
});
