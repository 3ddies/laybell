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
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../constants/theme';

export default function EditProfileScreen() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
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
    const { data } = await supabase.from('profiles').select('display_name, username, bio, avatar_url').eq('id', user.id).single();
    if (data) { setDisplayName(data.display_name || ''); setUsername(data.username || ''); setBio(data.bio || ''); setAvatarUrl(data.avatar_url || null); }
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
    if (!updateError) setAvatarUrl(publicUrl);
    setUploadingPhoto(false);
  }

  async function handleSave() {
    if (!displayName.trim() || !username.trim()) { Alert.alert('Error', 'Display name and username are required'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { Alert.alert('Error', 'Username can only contain letters, numbers, and underscores'); return; }
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ display_name: displayName.trim(), username: username.trim().toLowerCase(), bio: bio.trim() }).eq('id', userId);
    if (error) {
      Alert.alert('Error', error.message.includes('unique') ? 'Username is already taken' : error.message);
      setSaving(false); return;
    }
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
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: COLORS.text, fontSize: 15, minHeight: 100, textAlignVertical: 'top',
  },
  charCount: { color: COLORS.textTertiary, fontSize: 12, alignSelf: 'flex-end' },
});
