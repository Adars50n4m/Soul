// mobile/app/otp.tsx
// Adapted from reference OTPScreen.tsx for Expo Router
import React, { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { authService } from '../services/AuthService';

const OTP_LENGTH  = 6;
const RESEND_WAIT = 60;

export default function OTPScreen() {
  const router = useRouter();
  const { email } = useLocalSearchParams<{ email: string }>();

  const [digits,    setDigits]    = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [loading,   setLoading]   = useState(false);
  const [resending, setResending] = useState(false);
  const [error,     setError]     = useState('');
  const [timer,     setTimer]     = useState(RESEND_WAIT);
  const [canResend, setCanResend] = useState(false);

  const inputRefs = useRef<(TextInput | null)[]>([]);
  const shakeAnim = useRef(new Animated.Value(0)).current;
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    startTimer();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const startTimer = () => {
    setTimer(RESEND_WAIT);
    setCanResend(false);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          setCanResend(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 10,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleDigitChange = useCallback((text: string, index: number) => {
    setError('');

    if (text.length > 1) {
      const pasted = text.replace(/\D/g, '').slice(0, OTP_LENGTH);
      const newDigits = [...Array(OTP_LENGTH).fill('')];
      pasted.split('').forEach((char, i) => { newDigits[i] = char; });
      setDigits(newDigits);
      const lastIndex = Math.min(pasted.length, OTP_LENGTH - 1);
      inputRefs.current[lastIndex]?.focus();
      if (pasted.length === OTP_LENGTH) {
        verifyCode(newDigits.join(''));
      }
      return;
    }

    const digit = text.replace(/\D/g, '');
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);

    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && index === OTP_LENGTH - 1) {
      const code = newDigits.join('');
      if (code.length === OTP_LENGTH) {
        verifyCode(code);
      }
    }
  }, [digits]);

  const handleKeyPress = useCallback((key: string, index: number) => {
    if (key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }, [digits]);

  const verifyCode = async (code: string) => {
    setLoading(true);
    setError('');

    const result = await authService.verifyOTP(email ?? '', code);

    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Invalid code.');
      setDigits(Array(OTP_LENGTH).fill(''));
      inputRefs.current[0]?.focus();
      shake();
      return;
    }

    if (result.isNewUser) {
      router.push('/username-setup');
    } else {
      router.replace('/(tabs)');
    }
  };

  const handleResend = async () => {
    if (!canResend || resending) return;
    setResending(true);
    setError('');
    setDigits(Array(OTP_LENGTH).fill(''));

    const result = await authService.sendOTP(email ?? '');

    setResending(false);

    if (!result.success) {
      setError(result.error ?? 'Could not resend code.');
      return;
    }

    startTimer();
    inputRefs.current[0]?.focus();
  };

  const maskedEmail = (email ?? '').replace(/^(.)(.*)(@)/, (_, first, _rest, at) => {
    return `${first}***${at}`;
  });

  const filledCount = digits.filter(d => d !== '').length;

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
          <Text style={styles.backBtnText}>← Change email</Text>
        </TouchableOpacity>

        <View style={styles.header}>
          <Text style={styles.title}>Check your inbox</Text>
          <Text style={styles.subtitle}>
            We sent a 6-digit code to{'\n'}
            <Text style={styles.emailHighlight}>{maskedEmail}</Text>
          </Text>
        </View>

        <Animated.View
          style={[styles.otpRow, { transform: [{ translateX: shakeAnim }] }]}
        >
          {digits.map((digit, index) => (
            <TextInput
              key={index}
              ref={ref => { inputRefs.current[index] = ref; }}
              style={[
                styles.otpBox,
                digit && styles.otpBoxFilled,
                error && styles.otpBoxError,
              ]}
              value={digit}
              onChangeText={text => handleDigitChange(text, index)}
              onKeyPress={({ nativeEvent }) => handleKeyPress(nativeEvent.key, index)}
              keyboardType="number-pad"
              maxLength={OTP_LENGTH}
              textAlign="center"
              selectionColor={AMBER}
              caretHidden
              autoFocus={index === 0}
            />
          ))}
        </Animated.View>

        {!!error && (
          <Text style={styles.errorText}>{error}</Text>
        )}

        {!error && filledCount > 0 && filledCount < OTP_LENGTH && (
          <Text style={styles.hintText}>{OTP_LENGTH - filledCount} more digits...</Text>
        )}

        {filledCount === OTP_LENGTH && (
          <TouchableOpacity
            style={[styles.verifyBtn, loading && styles.btnDisabled]}
            onPress={() => verifyCode(digits.join(''))}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#0A0A0F" size="small" />
              : <Text style={styles.verifyBtnText}>Verify →</Text>
            }
          </TouchableOpacity>
        )}

        {loading && filledCount === OTP_LENGTH && (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={AMBER} size="small" />
            <Text style={styles.loadingText}>Verifying...</Text>
          </View>
        )}

        <View style={styles.resendContainer}>
          {canResend ? (
            <TouchableOpacity onPress={handleResend} disabled={resending}>
              {resending
                ? <ActivityIndicator color={AMBER} size="small" />
                : <Text style={styles.resendActive}>Resend code</Text>
              }
            </TouchableOpacity>
          ) : (
            <Text style={styles.resendTimer}>
              Resend in <Text style={styles.resendTimerNum}>{timer}s</Text>
            </Text>
          )}
        </View>

        <Text style={styles.tip}>
          💡 Don't see it? Check your spam folder
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#F5A623';
const BG     = '#0A0A0F';
const BORDER = '#252535';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  container: { flex: 1, paddingHorizontal: 28, paddingTop: 60 },
  backBtn: { marginBottom: 40, alignSelf: 'flex-start' },
  backBtnText: { color: AMBER, fontSize: 15, fontWeight: '500' },
  header: { marginBottom: 40 },
  title: { fontSize: 28, fontWeight: '700', color: '#E8E8F0', marginBottom: 10 },
  subtitle: { fontSize: 15, color: '#888899', lineHeight: 22 },
  emailHighlight: { color: AMBER, fontWeight: '600' },
  otpRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  otpBox: {
    width: 48, height: 58, borderRadius: 12, borderWidth: 1.5,
    borderColor: BORDER, backgroundColor: '#13131C',
    color: '#E8E8F0', fontSize: 24, fontWeight: '700',
  },
  otpBoxFilled: { borderColor: AMBER, backgroundColor: '#1A1408' },
  otpBoxError: { borderColor: '#FF4444', backgroundColor: '#1A0808' },
  errorText: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  hintText: { color: '#555566', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  verifyBtn: {
    backgroundColor: AMBER, borderRadius: 12, height: 52,
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  btnDisabled: { opacity: 0.6 },
  verifyBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '700' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 16 },
  loadingText: { color: AMBER, fontSize: 14 },
  resendContainer: { alignItems: 'center', marginTop: 8, marginBottom: 16, height: 30 },
  resendTimer: { color: '#555566', fontSize: 14 },
  resendTimerNum: { color: '#888899', fontWeight: '600' },
  resendActive: { color: AMBER, fontSize: 15, fontWeight: '600' },
  tip: { color: '#444455', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
