// mobile/app/signup.tsx
// New user signup: enter email → send OTP → verify → username+password → profile
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useRouter } from 'expo-router';
import { authService } from '../services/AuthService';

export default function SignupScreen() {
  const router = useRouter();

  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSendOTP = async () => {
    if (loading) return;
    
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }

    setError('');
    setLoading(true);

    const result = await authService.signUpWithEmail(trimmed);

    setLoading(false);

    if (result.success) {
      router.push({ pathname: '/otp', params: { email: trimmed } });
    } else {
      setError(result.error ?? 'Could not send verification code.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0A0A0F" />

      <View style={styles.container}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.back()}
        >
          <Text style={styles.backBtnText}>← Back to Login</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Text style={styles.bigIcon}>✨</Text>
          <Text style={styles.title}>Create Account</Text>
          <Text style={styles.subtitle}>
            Enter your email to get started.{'\n'}
            We'll send a verification code to confirm it's you.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>EMAIL ADDRESS</Text>
          <View style={[styles.inputWrapper, error ? styles.inputError : null]}>
            <Text style={styles.inputIcon}>✉️</Text>
            <TextInput
              style={styles.input}
              placeholder="your@email.com"
              placeholderTextColor="#555566"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              value={email}
              onChangeText={(t) => { setEmail(t); setError(''); }}
              returnKeyType="send"
              onSubmitEditing={handleSendOTP}
              autoFocus
            />
          </View>

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={handleSendOTP}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#0A0A0F" size="small" />
              : <Text style={styles.primaryBtnText}>Send Verification Code →</Text>
            }
          </TouchableOpacity>

          <Text style={styles.note}>
            After verification, you'll set up your username, password, and profile.
          </Text>
        </View>

        <View style={styles.footerRow}>
          <Text style={styles.footerText}>Already have an account? </Text>
          <TouchableOpacity onPress={() => router.back()}>
            <Text style={styles.footerLink}>Login</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#F5A623';
const BG     = '#0A0A0F';
const BORDER = '#252535';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  container: { flex: 1, paddingHorizontal: 24, paddingTop: 60 },
  backBtn: { marginBottom: 32, alignSelf: 'flex-start' },
  backBtnText: { color: AMBER, fontSize: 15, fontWeight: '500' },
  header: { marginBottom: 36 },
  bigIcon: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '700', color: '#E8E8F0', marginBottom: 10 },
  subtitle: { fontSize: 15, color: '#888899', lineHeight: 22 },
  card: {
    backgroundColor: '#13131C', borderRadius: 20, padding: 24,
    borderWidth: 1, borderColor: BORDER,
  },
  label: { color: '#AAAABC', fontSize: 12, fontWeight: '600', letterSpacing: 1, marginBottom: 10 },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D0D16',
    borderRadius: 12, borderWidth: 1.5, borderColor: BORDER,
    paddingHorizontal: 14, height: 52, marginBottom: 12,
  },
  inputError: { borderColor: '#FF4444' },
  inputIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 16 },
  errorText: { color: '#FF6B6B', fontSize: 13, marginBottom: 12, marginLeft: 4 },
  primaryBtn: {
    backgroundColor: AMBER, borderRadius: 12, height: 52,
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '700' },
  note: { color: '#555566', fontSize: 12, textAlign: 'center', marginTop: 16, lineHeight: 18 },
  footerRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 28 },
  footerText: { color: '#888899', fontSize: 15 },
  footerLink: { color: AMBER, fontSize: 15, fontWeight: '600' },
});
