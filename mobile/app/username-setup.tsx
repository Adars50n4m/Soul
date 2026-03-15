// mobile/app/username-setup.tsx
// Same UI style as login screen with animated bears
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StatusBar,
  Animated,
  Dimensions,
} from 'react-native';
import Svg, { Circle, Path, Ellipse, G } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { authService } from '../services/AuthService';
import { GlassView } from '../components/ui/GlassView';

const { width: SCREEN_W } = Dimensions.get('window');

const STROKE = '#3A2B24';
const C = {
  bg:           '#000000',
  card:         'rgba(26, 26, 28, 0.40)',
  cardBorder:   'rgba(255, 255, 255, 0.10)',
  accent:       '#BC002A',
  accentDark:   '#9B0022',
  input:        '#262628',
  inputBorder:  '#3A3A3C',
  inputFocus:   '#BC002A',
  text:         '#FFFFFF',
  textMuted:    '#9CA3AF',
  textSub:      '#999999',
};

type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

function getPasswordStrength(password: string): {
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
  score: number;
  color: string;
} {
  if (password.length < 6) return { label: 'Too short', score: 0, color: '#FF4444' };

  let score = 0;
  if (password.length >= 8)           score++;
  if (/[A-Z]/.test(password))        score++;
  if (/[0-9]/.test(password))        score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const map = [
    { label: 'Weak'  as const, color: '#FF6B35' },
    { label: 'Fair'  as const, color: '#F5A623' },
    { label: 'Fair'  as const, color: '#F5A623' },
    { label: 'Strong' as const, color: '#4CAF50' },
  ];
  return { label: map[score].label, score, color: map[score].color };
}

export default function UsernameSetupScreen() {
  const router = useRouter();

  // Animated values (same as login)
  const boyBreathe = useRef(new Animated.Value(0)).current;
  const girlBreathe = useRef(new Animated.Value(0)).current;
  const floatY = useRef(new Animated.Value(0)).current;
  const shakeX = useRef(new Animated.Value(0)).current;

  // Breathe loops
  useEffect(() => {
    const loop = (anim: Animated.Value, delay = 0) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 2000, useNativeDriver: true }),
        ])
      ).start();
    loop(boyBreathe, 0);
    loop(girlBreathe, 600);

    Animated.loop(
      Animated.sequence([
        Animated.timing(floatY, { toValue: -8, duration: 2200, useNativeDriver: true }),
        Animated.timing(floatY, { toValue: 0,  duration: 2200, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const [username,        setUsername]        = useState('');
  const [usernameState,   setUsernameState]   = useState<AvailabilityState>('idle');
  const [usernameMessage, setUsernameMessage] = useState('');

  const [password,        setPassword]        = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword,    setShowPassword]    = useState(false);
  const [showConfirm,     setShowConfirm]     = useState(false);

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const strength    = getPasswordStrength(password);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!username) {
      setUsernameState('idle');
      setUsernameMessage('');
      return;
    }

    setUsernameState('checking');

    debounceRef.current = setTimeout(async () => {
      const result = await authService.checkUsernameAvailability(username);

      if (result.error) {
        setUsernameState('invalid');
        setUsernameMessage(result.error);
      } else if (result.available) {
        setUsernameState('available');
        setUsernameMessage('@' + username.toLowerCase() + ' is available!');
      } else {
        setUsernameState('taken');
        setUsernameMessage('This username is already taken.');
      }
    }, 600);
  }, [username]);

  const getStatusIcon = () => {
    switch (usernameState) {
      case 'checking':  return <ActivityIndicator color={AMBER} size="small" />;
      case 'available': return <Text style={styles.iconGreen}>✓</Text>;
      case 'taken':     return <Text style={styles.iconRed}>✗</Text>;
      case 'invalid':   return <Text style={styles.iconRed}>!</Text>;
      default:          return null;
    }
  };

  const handleNext = async () => {
    setError('');

    if (usernameState !== 'available') {
      setError('Please choose a valid, available username.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    router.push({
      pathname: '/profile-setup',
      params: { username, password },
    });
  };

  // Bear configs (same as login)
  const bears = [
    { id: 'boy',  cx: 145, cy: 90, color: '#FFFFFF', snout: '#FFF0F5', cheek: '#FFCAD6', peekArm: 'right' },
    { id: 'girl', cx: 255, cy: 90, color: '#D69E71', snout: '#F0C4A5', cheek: '#F08B8B', peekArm: 'left'  },
  ];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Bears SVG Header */}
      <Animated.View style={{ transform: [{ translateY: floatY }, { translateX: shakeX }], alignItems: 'center', marginBottom: -50 }}>
        <Svg width="400" height="200" viewBox="0 0 400 300">
          {bears.map(({ id, cx, cy, color, snout, cheek, peekArm }) => (
            <G key={id}>
              <Ellipse cx={cx-24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
              <Ellipse cx={cx+24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
              <Path d={`M ${cx-34} ${cy+25} C ${cx-65} ${cy+60},${cx-60} ${cy+135},${cx} ${cy+135} C ${cx+60} ${cy+135},${cx+65} ${cy+60},${cx+34} ${cy+25} Z`} fill={color} stroke={STROKE} strokeWidth="5" />
              <Circle cx={cx-48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
              <Circle cx={cx+48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
              <Path d={`M ${cx} ${cy-50} C ${cx+45} ${cy-50},${cx+72} ${cy-20},${cx+72} ${cy+15} C ${cx+72} ${cy+55},${cx+40} ${cy+65},${cx} ${cy+65} C ${cx-40} ${cy+65},${cx-72} ${cy+55},${cx-72} ${cy+15} C ${cx-72} ${cy-20},${cx-45} ${cy-50},${cx} ${cy-50} Z`} fill={color} stroke={STROKE} strokeWidth="5" />
              <Ellipse cx={cx} cy={cy+19} rx="22" ry="16" fill={snout} />
              <Ellipse cx={cx-42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
              <Ellipse cx={cx+42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
              <Circle cx={cx-24} cy={cy+5} r="6.5" fill={STROKE} />
              <Circle cx={cx-21.5} cy={cy+2.5} r="2" fill="#fff" />
              <Circle cx={cx+24} cy={cy+5} r="6.5" fill={STROKE} />
              <Circle cx={cx+26.5} cy={cy+2.5} r="2" fill="#fff" />
              <Path d={`M ${cx-2} ${cy+11} Q ${cx} ${cy+13} ${cx+2} ${cy+11} Z`} fill={STROKE} stroke={STROKE} strokeWidth="2" />
              <Path d={`M ${cx-7} ${cy+18} Q ${cx} ${cy+20} ${cx+7} ${cy+18} C ${cx+7} ${cy+28},${cx-7} ${cy+28},${cx-7} ${cy+18} Z`} fill={STROKE} stroke={STROKE} strokeWidth="3" />
            </G>
          ))}
        </Svg>
      </Animated.View>

      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 22, justifyContent: 'center' }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Glass Card */}
        <GlassView intensity={Platform.OS === 'ios' ? 80 : 60} tint="dark" style={s.card}>
          <Text style={s.title}>Create Soul Id</Text>
          <Text style={s.subtitle}>Choose your unique identity</Text>

          {/* Back link */}
          <TouchableOpacity onPress={() => router.back()} style={s.backLink}>
            <Feather name="arrow-left" size={18} color={C.accent} />
            <Text style={s.backText}> Back to login</Text>
          </TouchableOpacity>

        {/* Username */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Username</Text>
          <View style={[
            styles.inputWrapper,
            usernameState === 'available' && styles.inputSuccess,
            (usernameState === 'taken' || usernameState === 'invalid') && styles.inputError,
          ]}>
            <Text style={styles.atSign}>@</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. alex_99"
              placeholderTextColor="#555566"
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={setUsername}
            />
            <View style={styles.statusIcon}>
              {getStatusIcon()}
            </View>
          </View>

          {!!usernameMessage && (
            <Text style={[
              styles.fieldHint,
              usernameState === 'available' ? styles.hintGreen : styles.hintRed,
            ]}>
              {usernameMessage}
            </Text>
          )}

          <View style={styles.rulesList}>
            <Text style={styles.rule}>• 3–20 characters</Text>
            <Text style={styles.rule}>• Letters, numbers, . and _</Text>
            <Text style={styles.rule}>• Cannot start with . or _</Text>
          </View>
        </View>

        {/* Password */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Password</Text>
          <View style={styles.inputWrapper}>
            <Text style={styles.fieldIcon}>🔒</Text>
            <TextInput
              style={styles.input}
              placeholder="Min. 8 characters"
              placeholderTextColor="#555566"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(v => !v)}
              style={styles.eyeBtn}
            >
              <Text style={styles.eyeIcon}>{showPassword ? '🙈' : '👁️'}</Text>
            </TouchableOpacity>
          </View>

          {password.length > 0 && (
            <View style={styles.strengthRow}>
              <View style={styles.strengthBars}>
                {[0, 1, 2, 3].map(i => (
                  <View
                    key={i}
                    style={[
                      styles.strengthBar,
                      i < strength.score
                        ? { backgroundColor: strength.color }
                        : { backgroundColor: '#252535' },
                    ]}
                  />
                ))}
              </View>
              <Text style={[styles.strengthLabel, { color: strength.color }]}>
                {strength.label}
              </Text>
            </View>
          )}
        </View>

        {/* Confirm Password */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Confirm Password</Text>
          <View style={[
            styles.inputWrapper,
            confirmPassword.length > 0 && confirmPassword === password && styles.inputSuccess,
            confirmPassword.length > 0 && confirmPassword !== password && styles.inputError,
          ]}>
            <Text style={styles.fieldIcon}>🔒</Text>
            <TextInput
              style={styles.input}
              placeholder="Repeat your password"
              placeholderTextColor="#555566"
              secureTextEntry={!showConfirm}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              onPress={() => setShowConfirm(v => !v)}
              style={styles.eyeBtn}
            >
              <Text style={styles.eyeIcon}>{showConfirm ? '🙈' : '👁️'}</Text>
            </TouchableOpacity>
          </View>
          {confirmPassword.length > 0 && confirmPassword !== password && (
            <Text style={[styles.fieldHint, styles.hintRed]}>Passwords don't match</Text>
          )}
        </View>

        {!!error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[styles.nextBtn, loading && styles.btnDisabled]}
          onPress={handleNext}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#0A0A0F" size="small" />
            : <Text style={styles.nextBtnText}>Next →</Text>
          }
        </TouchableOpacity>
        </GlassView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#BC002A';
const BG     = '#000000';
const BORDER = '#252535';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  scrollContent: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 40 },
  header: { marginBottom: 36 },
  step: { color: AMBER, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 26, fontWeight: '700', color: '#E8E8F0', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888899', lineHeight: 20 },
  fieldGroup: { marginBottom: 24 },
  label: { color: '#AAAABC', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#13131C',
    borderRadius: 12, borderWidth: 1.5, borderColor: BORDER,
    paddingHorizontal: 14, height: 52,
  },
  inputSuccess: { borderColor: '#4CAF50' },
  inputError: { borderColor: '#FF4444' },
  atSign: { color: AMBER, fontSize: 18, fontWeight: '700', marginRight: 6 },
  fieldIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 16 },
  statusIcon: { width: 24, alignItems: 'center' },
  iconGreen: { color: '#4CAF50', fontSize: 18, fontWeight: '700' },
  iconRed: { color: '#FF4444', fontSize: 18, fontWeight: '700' },
  eyeBtn: { padding: 4 },
  eyeIcon: { fontSize: 16 },
  fieldHint: { fontSize: 13, marginTop: 6, marginLeft: 4 },
  hintGreen: { color: '#4CAF50' },
  hintRed: { color: '#FF6B6B' },
  rulesList: { marginTop: 8, gap: 2 },
  rule: { color: '#555566', fontSize: 12, lineHeight: 18 },
  strengthRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 10 },
  strengthBars: { flexDirection: 'row', gap: 4, flex: 1 },
  strengthBar: { flex: 1, height: 4, borderRadius: 2 },
  strengthLabel: { fontSize: 12, fontWeight: '600', minWidth: 55, textAlign: 'right' },
  errorText: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', marginBottom: 16 },
  nextBtn: { backgroundColor: AMBER, borderRadius: 12, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.6 },
  nextBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '700' },
});

// Glass card styles (same as login)
const s = StyleSheet.create({
  card: {
    width: '100%',
    backgroundColor: C.card,
    borderRadius: 40,
    paddingHorizontal: 28,
    paddingTop: 44,
    paddingBottom: 32,
    borderWidth: 1,
    borderColor: C.cardBorder,
    overflow: 'hidden',
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.5,
    shadowRadius: 28,
    elevation: 14,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: C.accent,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 26,
    fontWeight: '500',
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  backText: {
    color: C.accent,
    fontSize: 14,
    fontWeight: '600',
  },
});
