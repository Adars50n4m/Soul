// mobile/app/forgot-password.tsx
// Adapted from reference ForgotPasswordScreen.tsx for Expo Router
import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Animated,
  StatusBar,
  ScrollView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { authService } from '../services/AuthService';

type ScreenState = 'enterEmail' | 'emailSent' | 'setNewPassword' | 'passwordUpdated';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const fromDeepLink = mode === 'reset';

  const [screenState,  setScreenState]  = useState<ScreenState>(
    fromDeepLink ? 'setNewPassword' : 'enterEmail'
  );

  const [email,           setEmail]           = useState('');
  const [newPassword,     setNewPassword]     = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew,         setShowNew]         = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState('');

  const shakeAnim = useRef(new Animated.Value(0)).current;

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleSendReset = async () => {
    if (!email.trim()) {
      setError('Please enter your email address.');
      shake();
      return;
    }
    setError('');
    setLoading(true);

    const result = await authService.sendPasswordResetEmail(email);

    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Something went wrong.');
      shake();
      return;
    }

    setScreenState('emailSent');
  };

  const handleUpdatePassword = async () => {
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      shake();
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      shake();
      return;
    }

    setError('');
    setLoading(true);

    const result = await authService.updatePassword(newPassword);

    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Could not update password.');
      shake();
      return;
    }

    setScreenState('passwordUpdated');
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0A0A0F" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => router.push('/login')}
        >
          <Text style={styles.backBtnText}>← Back to Login</Text>
        </TouchableOpacity>

        {/* STATE: Enter Email */}
        {screenState === 'enterEmail' && (
          <>
            <View style={styles.header}>
              <Text style={styles.bigIcon}>🔑</Text>
              <Text style={styles.title}>Forgot Password?</Text>
              <Text style={styles.subtitle}>
                No worries! Enter your email and we'll send you a reset link.
              </Text>
            </View>

            <Animated.View
              style={[styles.card, { transform: [{ translateX: shakeAnim }] }]}
            >
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
                  onChangeText={t => { setEmail(t); setError(''); }}
                  returnKeyType="send"
                  onSubmitEditing={handleSendReset}
                />
              </View>

              {!!error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.btnDisabled]}
                onPress={handleSendReset}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#0A0A0F" size="small" />
                  : <Text style={styles.primaryBtnText}>Send Reset Link</Text>
                }
              </TouchableOpacity>
            </Animated.View>
          </>
        )}

        {/* STATE: Email Sent */}
        {screenState === 'emailSent' && (
          <View style={styles.centeredContent}>
            <Text style={styles.bigIcon}>📬</Text>
            <Text style={styles.title}>Check your inbox!</Text>
            <Text style={styles.subtitle}>
              We sent a password reset link to{'\n'}
              <Text style={styles.emailHighlight}>{email}</Text>
            </Text>

            <View style={styles.infoCard}>
              <Text style={styles.infoText}>
                • Tap the link in the email{'\n'}
                • It will open SoulSync automatically{'\n'}
                • Link expires in 1 hour{'\n'}
                • Check spam if you don't see it
              </Text>
            </View>

            <TouchableOpacity onPress={() => setScreenState('enterEmail')}>
              <Text style={styles.resendLink}>
                Didn't receive it? Try again
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* STATE: Set New Password */}
        {screenState === 'setNewPassword' && (
          <>
            <View style={styles.header}>
              <Text style={styles.bigIcon}>🔒</Text>
              <Text style={styles.title}>Set New Password</Text>
              <Text style={styles.subtitle}>
                Choose a strong password for your SoulSync account
              </Text>
            </View>

            <Animated.View
              style={[styles.card, { transform: [{ translateX: shakeAnim }] }]}
            >
              <Text style={styles.fieldLabel}>New Password</Text>
              <View style={styles.inputWrapper}>
                <Text style={styles.inputIcon}>🔒</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Min. 8 characters"
                  placeholderTextColor="#555566"
                  secureTextEntry={!showNew}
                  value={newPassword}
                  onChangeText={t => { setNewPassword(t); setError(''); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowNew(v => !v)}>
                  <Text style={styles.eyeIcon}>{showNew ? '🙈' : '👁️'}</Text>
                </TouchableOpacity>
              </View>

              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>
                Confirm Password
              </Text>
              <View style={[
                styles.inputWrapper,
                confirmPassword.length > 0 && confirmPassword !== newPassword
                  ? styles.inputError : null,
              ]}>
                <Text style={styles.inputIcon}>🔒</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Repeat your password"
                  placeholderTextColor="#555566"
                  secureTextEntry={!showConfirm}
                  value={confirmPassword}
                  onChangeText={t => { setConfirmPassword(t); setError(''); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity onPress={() => setShowConfirm(v => !v)}>
                  <Text style={styles.eyeIcon}>{showConfirm ? '🙈' : '👁️'}</Text>
                </TouchableOpacity>
              </View>

              {!!error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.primaryBtn, { marginTop: 20 }, loading && styles.btnDisabled]}
                onPress={handleUpdatePassword}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading
                  ? <ActivityIndicator color="#0A0A0F" size="small" />
                  : <Text style={styles.primaryBtnText}>Update Password →</Text>
                }
              </TouchableOpacity>
            </Animated.View>
          </>
        )}

        {/* STATE: Password Updated */}
        {screenState === 'passwordUpdated' && (
          <View style={styles.centeredContent}>
            <Text style={styles.bigIcon}>✅</Text>
            <Text style={styles.title}>Password Updated!</Text>
            <Text style={styles.subtitle}>
              Your password has been changed successfully.{'\n'}
              You can now log in with your new password.
            </Text>

            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => router.push('/login')}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Back to Login →</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#F5A623';
const BG     = '#0A0A0F';
const BORDER = '#252535';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  scrollContent: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 40, flexGrow: 1 },
  backBtn: { marginBottom: 32, alignSelf: 'flex-start' },
  backBtnText: { color: AMBER, fontSize: 15, fontWeight: '500' },
  header: { marginBottom: 32 },
  bigIcon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 26, fontWeight: '700', color: '#E8E8F0', marginBottom: 10 },
  subtitle: { fontSize: 15, color: '#888899', lineHeight: 22 },
  emailHighlight: { color: AMBER, fontWeight: '600' },
  card: { backgroundColor: '#13131C', borderRadius: 20, padding: 24, borderWidth: 1, borderColor: BORDER },
  fieldLabel: { color: '#AAAABC', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#0D0D16',
    borderRadius: 12, borderWidth: 1.5, borderColor: BORDER,
    paddingHorizontal: 14, height: 52, marginBottom: 8,
  },
  inputError: { borderColor: '#FF4444' },
  inputIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 16 },
  eyeIcon: { fontSize: 16, padding: 4 },
  errorText: { color: '#FF6B6B', fontSize: 13, marginBottom: 12, marginLeft: 4 },
  primaryBtn: { backgroundColor: AMBER, borderRadius: 12, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '700' },
  centeredContent: { flex: 1, alignItems: 'center', paddingTop: 20 },
  infoCard: {
    backgroundColor: '#13131C', borderRadius: 16, padding: 20,
    borderWidth: 1, borderColor: BORDER, marginTop: 28, marginBottom: 24, width: '100%',
  },
  infoText: { color: '#888899', fontSize: 14, lineHeight: 24 },
  resendLink: { color: AMBER, fontSize: 15, fontWeight: '600' },
});
