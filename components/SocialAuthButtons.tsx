import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING, type ThemePalette } from '../constants/theme';
import { useTheme, useThemedStyles } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { appleSignInAvailable, signInWithApple, signInWithGoogle } from '../lib/socialAuth';

// "Or continue with…" block shared by the login and signup screens. A social
// sign-in either signs in an existing account or creates one — the root auth
// listener + checkOnboarding route new users into onboarding automatically.
export default function SocialAuthButtons({ onError }: { onError: (msg: string) => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const [appleOk, setAppleOk] = useState(false);
  const [busy, setBusy] = useState<null | 'google' | 'apple'>(null);
  useEffect(() => { appleSignInAvailable().then(setAppleOk).catch(() => {}); }, []);

  async function run(kind: 'google' | 'apple') {
    if (busy) return;
    setBusy(kind);
    const res = kind === 'google' ? await signInWithGoogle() : await signInWithApple();
    if (res.error) onError(res.error);
    setBusy(null);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.dividerRow}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>{t('auth.or')}</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity
        style={styles.googleBtn}
        onPress={() => run('google')}
        disabled={!!busy}
        activeOpacity={0.85}
      >
        {busy === 'google' ? (
          <ActivityIndicator color="#1F1F1F" size="small" />
        ) : (
          <>
            <Ionicons name="logo-google" size={18} color="#1F1F1F" />
            <Text style={styles.googleText}>{t('auth.continueGoogle')}</Text>
          </>
        )}
      </TouchableOpacity>

      {appleOk && (
        <TouchableOpacity
          style={styles.appleBtn}
          onPress={() => run('apple')}
          disabled={!!busy}
          activeOpacity={0.85}
        >
          {busy === 'apple' ? (
            <ActivityIndicator color={colors.background} size="small" />
          ) : (
            <>
              <Ionicons name="logo-apple" size={19} color={colors.background} />
              <Text style={styles.appleText}>{t('auth.continueApple')}</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  wrap: { gap: SPACING.sm + 2, marginTop: SPACING.md },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: 2 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
  dividerText: { color: c.textTertiary, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  // Google: white pill with the brand-guideline dark label, every theme.
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: c.border,
    paddingVertical: SPACING.md,
  },
  googleText: { color: '#1F1F1F', fontSize: 15, fontWeight: '700' },
  // Apple: HIG inversion — black button on light themes, white on dark.
  appleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: c.text, borderRadius: RADIUS.md,
    paddingVertical: SPACING.md,
  },
  appleText: { color: c.background, fontSize: 15, fontWeight: '700' },
});
