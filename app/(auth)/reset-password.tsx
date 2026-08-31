import {
  View, Text, TouchableOpacity, Image,
  StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Keyboard,
} from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import AuthBackdrop from '../../components/AuthBackdrop';
import AuthField from '../../components/AuthField';
import AuthSubmitButton from '../../components/AuthSubmitButton';
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

    // Close the keyboard now that we are actually submitting — after the
    // guards, so a rejected password does not shut it on someone who has to go
    // straight back into the field. Same reasoning as login.tsx.
    Keyboard.dismiss();
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
        {/* Also here, or the bloom would blink out the instant the save lands —
            this state replaces the form in place, it is not a new screen. */}
        <AuthBackdrop />
        {/* The success state has no inputs, so it needs no scroll or keyboard
            handling — a plain centred View is right here. */}
        <View style={styles.innerStatic}>
          <View style={styles.logoSection}>
            <Ionicons name="checkmark-circle" size={64} color={colors.primary} />
            <Text style={styles.title}>{t('rpw.doneTitle')}</Text>
            <Text style={styles.body}>{t('rpw.doneBody')}</Text>
          </View>
          <AuthSubmitButton label={t('rpw.continue')} onPress={() => router.replace('/(tabs)')} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="height"
      // OFF on iOS on purpose. Resizing the container re-centres the form and
      // makes it leap; automaticallyAdjustKeyboardInsets on the ScrollView
      // below handles iOS without touching layout at all.
      enabled={Platform.OS !== 'ios'}
    >
      <AuthBackdrop progress={((password ? 1 : 0) + (confirm ? 1 : 0)) / 2} />
      {/* Same treatment as login.tsx: keyboardShouldPersistTaps="handled" makes a
          tap on empty space close the keyboard while a tap on a control still
          fires, and on-drag closes it on a scroll. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.inner}
        keyboardShouldPersistTaps="handled"
        // Adjusts contentInset rather than resizing — see the KeyboardAvoidingView above.
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
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

          {/* AuthField, as login and signup already use: a hairline that turns
              neutral-on-focus, a fill that lifts a step, and an icon that goes
              full-strength while the field is live. This screen and verify-email
              were the last two hand-rolling their own inputs, which is how the
              focus state existed on two of the four auth screens.

              textContentType/autoComplete say NEW password, not password: that
              is what makes iOS offer a generated one and save it afterwards, and
              it is the difference between a reset screen the keychain
              understands and one it treats as a login it cannot place. */}
          <AuthField
            icon="lock-closed-outline"
            placeholder={t('rpw.newPassword')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!show}
            autoCapitalize="none"
            textContentType="newPassword"
            autoComplete="new-password"
            editable={!saving}
            right={(
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={show ? t('a11y.hidePassword') : t('a11y.showPassword')}
                onPress={() => setShow((s) => !s)}
              >
                <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={18} color={colors.textMeta} />
              </TouchableOpacity>
            )}
          />

          <AuthField
            icon="lock-closed-outline"
            placeholder={t('auth.confirmPassword')}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry={!show}
            autoCapitalize="none"
            textContentType="newPassword"
            autoComplete="new-password"
            editable={!saving}
          />

          <AuthSubmitButton
            label={t('rpw.save')}
            onPress={submit}
            loading={saving}
            disabled={saving}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: ThemePalette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  innerStatic: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },
  // flexGrow, not flex — see login.tsx: flex:1 on a contentContainer pins it
  // to the viewport and kills scrolling.
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  body: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', lineHeight: 20 },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: colors.error, fontSize: 13, flex: 1 },

  // The input and button styles that used to live here are gone with the
  // hand-rolled controls — AuthField and AuthSubmitButton own them now.
});
