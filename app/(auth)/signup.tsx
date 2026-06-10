import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView,
} from 'react-native';
import { useState } from 'react';
import { Link } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import { COLORS, SPACING, RADIUS, GRADIENTS } from '../../constants/theme';

type Field = { icon: any; placeholder: string; value: string; onChange: (v: string) => void; secure?: boolean; keyboard?: any; capitalize?: any; maxLength?: number };

export default function SignupScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showPass, setShowPass] = useState(false);

  async function handleSignup() {
    if (!email || !password || !confirmPassword || !username || !displayName) { setError('Please fill in all fields'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (username.length < 5) { setError('Username must be at least 5 characters'); return; }
    if (username.length > 30) { setError('Username must be 30 characters or less'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) { setError('Username can only contain letters, numbers, and underscores'); return; }

    setLoading(true); setError('');
    const { error: signUpError } = await supabase.auth.signUp({
      email: email.trim(), password,
      options: { data: { username: username.trim().toLowerCase(), display_name: displayName.trim() } },
    });
    if (signUpError) setError(signUpError.message);
    setLoading(false);
  }

  const fields: Field[] = [
    { icon: 'person-outline', placeholder: 'Display Name', value: displayName, onChange: setDisplayName },
    { icon: 'at-outline', placeholder: 'Username', value: username, onChange: setUsername, capitalize: 'none', maxLength: 30 },
    { icon: 'mail-outline', placeholder: 'Email', value: email, onChange: setEmail, capitalize: 'none', keyboard: 'email-address' },
    { icon: 'lock-closed-outline', placeholder: 'Password', value: password, onChange: setPassword, secure: true },
    { icon: 'lock-closed-outline', placeholder: 'Confirm Password', value: confirmPassword, onChange: setConfirmPassword, secure: true },
  ];

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>

        <View style={styles.logoSection}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.logoMark}>
            <Ionicons name="musical-notes" size={32} color={COLORS.text} />
          </LinearGradient>
          <Text style={styles.logo}>Laybell</Text>
          <Text style={styles.tagline}>Join the movement.</Text>
        </View>

        <View style={styles.form}>
          {!!error && (
            <View style={styles.errorRow}>
              <Ionicons name="alert-circle-outline" size={15} color={COLORS.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {fields.map((f, i) => (
            <View key={i} style={styles.inputWrap}>
              <Ionicons name={f.icon} size={18} color={COLORS.textTertiary} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder={f.placeholder}
                placeholderTextColor={COLORS.textTertiary}
                value={f.value}
                onChangeText={f.onChange}
                secureTextEntry={f.secure && !showPass}
                keyboardType={f.keyboard}
                autoCapitalize={f.capitalize ?? 'words'}
                maxLength={f.maxLength}
              />
              {f.secure && (
                <TouchableOpacity onPress={() => setShowPass(p => !p)}>
                  <Ionicons name={showPass ? 'eye-off-outline' : 'eye-outline'} size={18} color={COLORS.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
          ))}

          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={handleSignup}
            disabled={loading}
          >
            {loading ? <ActivityIndicator color={COLORS.text} /> : <Text style={styles.buttonText}>Create Account</Text>}
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <Link href="/(auth)/login" asChild>
            <TouchableOpacity><Text style={styles.linkText}>Log In</Text></TouchableOpacity>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: SPACING.lg, paddingVertical: SPACING.xxl },

  logoSection: { alignItems: 'center', marginBottom: SPACING.xl, gap: SPACING.sm },
  logoMark: { width: 72, height: 72, borderRadius: RADIUS.xl, alignItems: 'center', justifyContent: 'center' },
  logo: { fontSize: 36, fontWeight: '800', color: COLORS.text, letterSpacing: 1 },
  tagline: { fontSize: 14, color: COLORS.textSecondary },

  form: { gap: SPACING.md },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: COLORS.error + '18', borderRadius: RADIUS.md, padding: SPACING.sm + 2 },
  errorText: { color: COLORS.error, fontSize: 13, flex: 1 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border,
    borderRadius: RADIUS.md, paddingHorizontal: SPACING.md, gap: SPACING.sm,
  },
  inputIcon: { flexShrink: 0 },
  input: { flex: 1, paddingVertical: SPACING.md, color: COLORS.text, fontSize: 15 },

  button: { backgroundColor: COLORS.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.md + 2, alignItems: 'center', marginTop: SPACING.sm },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: COLORS.text, fontSize: 16, fontWeight: '700' },

  footer: { flexDirection: 'row', justifyContent: 'center', marginTop: SPACING.xl },
  footerText: { color: COLORS.textSecondary, fontSize: 14 },
  linkText: { color: COLORS.primary, fontSize: 14, fontWeight: '700' },
});
