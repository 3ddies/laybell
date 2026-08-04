import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { SPACING, RADIUS, type ThemePalette } from '../../constants/theme';
import { useTheme, useThemedStyles } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LanguageContext';

// Where a password-reset link lands. The recovery link establishes a session
// (app/_layout.tsx routes here when handleAuthLink reports 'recovery'), and this
// screen is the only place that actually SETS the password — before it existed,
// Settings sent a reset email whose link had nowhere to go.
export default function ResetPasswordScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit() {
    if (!password || !confirm) { setError(t('auth.fillAllFields')); return; }
    if (password !== confirm) { setError(t('auth.passwordsNoMatch')); return; }
    if (password.length < 6) { setError(t('auth.passwordMin')); return; }

    setSaving(true); setError('');
    const { error: err } = await supabase.auth.updateUser({ password });
    setSaving(false);

    if (err) {
      // The recovery session is short-lived; an expired one is the likeliest
      // failure and needs different advice than a bad password.
      setError(/session|jwt|expired|not authenticated/i.test(err.message)
        ? t('rpw.expired')
        : err.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <View style={styles.container}>
        <View style={styles.inner}>
          <View style={styles.logoSection}>
            <Ionicons name="checkmark-circle" size={64} color={colors.primary} />
            <Text style={styles.title}>{t('rpw.doneTitle')}</Text>
            <Text style={styles.body}>{t('rpw.doneBody')}</Text>
          </View>
          <TouchableOpacity style={styles.button} onPress={() => router.replace('/(tabs)')}>
            <Text style={styles.buttonText}>{t('rpw.continue')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.inner}>
        <View style={styles.logoSection}>
          <Image source={require('../../assets/icon.png')} style={styles.logoMark} resizeMode="cover" />
          <Text style={styles.title}>{t('rpw.title')}</Text>
          <Text style={styles.body}>{t('rpw.body')}</Text>
        </View>

        <View style={styles.form}>
          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={15} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('rpw.newPassword')}
              placeholderTextColor={colors.textTertiary}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!show}
              autoCapitalize="none"
              editable={!saving}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={show ? t('a11y.hidePassword') : t('a11y.showPassword')}
              onPress={() => setShow((s) => !s)}
            >
              <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>

          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textTertiary} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              placeholder={t('auth.confirmPassword')}
              placeholderTextColor={colors.textTertiary}
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry={!show}
              autoCapitalize="none"
              editable={!saving}
            />
          </View>

          <TouchableOpacity
            style={[styles.button, saving && styles.buttonDisabled]}
            onPress={submit}
            disabled={saving}
          >
            {saving ? <ActivityIndicator color={colors.text} /> : <Text style={styles.buttonText}>{t('rpw.save')}</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  body: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    backgroundColor: colors.surfaceLight, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, height: 50,
  },
  inputIcon: { width: 20 },
  input: { flex: 1, color: colors.text, fontSize: 15 },

  button: {
    backgroundColor: colors.primary, borderRadius: RADIUS.md,
    height: 50, alignItems: 'center', justifyContent: 'center', marginTop: SPACING.xs,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: '700' },
});
