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
} from 'react-native';
import Svg, { Circle, Path, Ellipse, G } from 'react-native-svg';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useApp } from '../context/AppContext';
import { GlassView } from '../components/ui/GlassView';
import { authService } from '../services/AuthService';
import { LinearGradient } from 'expo-linear-gradient';

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
  const { oauthMode } = useLocalSearchParams<{ oauthMode?: string }>();
  const isOauthMode = oauthMode === 'true';
  const { activeTheme, logout } = useApp();
  const themeAccent = activeTheme.primary;

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
      try {
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
      } catch (e) {
        setUsernameState('invalid');
        setUsernameMessage('Error checking availability.');
      }
    }, 600);
  }, [username]);

  const getStatusIcon = () => {
    switch (usernameState) {
      case 'checking':  return <ActivityIndicator color={themeAccent} size="small" />;
      case 'available': return <Text style={styles.iconGreen}>✓</Text>;
      case 'taken':     return <Text style={styles.iconRed}>✗</Text>;
      case 'invalid':   return <Text style={styles.iconRed}>!</Text>;
      default:          return null;
    }
  };

  const handleBack = async () => {
    if (isOauthMode) {
      await logout();
      return;
    }

    router.back();
  };

  const handleNext = async () => {
    setError('');

    if (usernameState !== 'available') {
      setError('Please choose a valid, available username.');
      return;
    }
    
    if (!isOauthMode) {
      if (password.length < 8) {
        setError('Password must be at least 8 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    router.push({
      pathname: '/profile-setup',
      params: { username, password: isOauthMode ? undefined : password },
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
      <View style={styles.bgOrbOne} />
      <View style={styles.bgOrbTwo} />
      <LinearGradient
        colors={['rgba(188,0,42,0.18)', 'rgba(188,0,42,0.02)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bgGlow}
      />

      {/* Bears SVG Header */}
      <Animated.View style={[styles.heroWrap, { transform: [{ translateY: floatY }, { translateX: shakeX }] }]}>
        <Svg width="400" height="200" viewBox="0 0 400 300">
          {bears.map(({ id, cx, cy, color, snout, cheek }) => (
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
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Glass Card */}
        <GlassView intensity={Platform.OS === 'ios' ? 80 : 60} tint="dark" style={s.card}>
          <View style={styles.stepPill}>
            <Text style={[styles.stepPillText, { color: themeAccent }]}>Step 1 of 2</Text>
          </View>
          <Text style={s.title}>Create your Soul ID</Text>
          <Text style={s.subtitle}>Pick a unique username and secure your account before profile setup.</Text>

          <View style={styles.progressRow}>
            <View style={[styles.progressSegment, { backgroundColor: themeAccent }]} />
            <View style={styles.progressSegmentMuted} />
          </View>

          {isOauthMode && (
            <View style={styles.oauthBanner}>
              <MaterialIcons name="verified-user" size={18} color={themeAccent} />
              <Text style={styles.oauthBannerText}>Google account connected. Just choose your Soul ID.</Text>
            </View>
          )}

          {/* Back link */}
          <TouchableOpacity onPress={handleBack} style={s.backLink}>
            <Feather name="arrow-left" size={18} color={themeAccent} />
            <Text style={[s.backText, { color: themeAccent }]}> Back to login</Text>
          </TouchableOpacity>

        <View style={styles.previewCardTop}>
          <View style={[styles.previewBadge, { borderColor: themeAccent }]}>
            <Text style={[styles.previewBadgeText, { color: themeAccent }]}>
              {(username || 's').slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.previewEyebrow}>Your Soul handle</Text>
            <Text style={styles.previewHandle}>@{username.trim().toLowerCase() || 'your_name'}</Text>
            <Text style={styles.previewHint}>This will be how people find and remember you.</Text>
          </View>
        </View>

        {/* Username */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Username</Text>
          <View style={[
            styles.inputWrapper,
            usernameState === 'available' && styles.inputSuccess,
            (usernameState === 'taken' || usernameState === 'invalid') && styles.inputError,
          ]}>
            <Text style={[styles.atSign, { color: themeAccent }]}>@</Text>
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
            <Text style={styles.rule}>• Letters, numbers, . and _ only</Text>
            <Text style={styles.rule}>• Cannot start with . or _</Text>
          </View>
        </View>

        {!isOauthMode && (
          <>
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
          </>
        )}

        {!!error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[styles.nextBtn, { backgroundColor: themeAccent }, loading && styles.btnDisabled]}
          onPress={handleNext}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#0A0A0F" size="small" />
            : <Text style={styles.nextBtnText}>Continue to profile</Text>
          }
        </TouchableOpacity>

        <Text style={styles.footerNote}>
          You can update your display name later, but your username should be chosen carefully.
        </Text>
        </GlassView>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fieldGroup: { marginBottom: 24 },
  bgOrbOne: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(188,0,42,0.08)',
    top: -80,
    right: -140,
  },
  bgOrbTwo: {
    position: 'absolute',
    width: 420,
    height: 420,
    borderRadius: 210,
    backgroundColor: 'rgba(255,255,255,0.03)',
    bottom: -120,
    left: -190,
  },
  bgGlow: {
    position: 'absolute',
    top: 90,
    left: 0,
    right: 0,
    height: 260,
  },
  heroWrap: {
    alignItems: 'center',
    marginBottom: -34,
    marginTop: 18,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
    justifyContent: 'center',
    paddingBottom: 26,
  },
  stepPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 14,
  },
  stepPillText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  progressRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 18,
  },
  progressSegment: {
    flex: 1,
    height: 6,
    borderRadius: 999,
  },
  progressSegmentMuted: {
    flex: 1,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  oauthBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  oauthBannerText: {
    flex: 1,
    color: '#D6D6E3',
    fontSize: 13,
    lineHeight: 18,
  },
  previewCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 22,
  },
  previewBadge: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1.5,
  },
  previewBadgeText: {
    fontSize: 24,
    fontWeight: '800',
  },
  previewEyebrow: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  previewHandle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  previewHint: {
    color: '#8E8EA0',
    fontSize: 12,
    lineHeight: 17,
  },
  label: { color: '#AAAABC', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#13131C',
    borderRadius: 16, borderWidth: 1.5, borderColor: '#252535',
    paddingHorizontal: 16, height: 58,
  },
  inputSuccess: { borderColor: '#4CAF50' },
  inputError: { borderColor: '#FF4444' },
  atSign: { fontSize: 18, fontWeight: '700', marginRight: 6 },
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
  nextBtn: { borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  btnDisabled: { opacity: 0.6 },
  nextBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  footerNote: {
    color: '#767688',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 14,
  },
});

// Glass card styles (same as login)
const s = StyleSheet.create({
  card: {
    width: '100%',
    backgroundColor: 'rgba(26, 26, 28, 0.40)',
    borderRadius: 40,
    paddingHorizontal: 28,
    paddingTop: 30,
    paddingBottom: 32,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.10)',
    overflow: 'hidden',
    zIndex: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.5,
    shadowRadius: 28,
    elevation: 14,
  },
  title: {
    fontSize: 34,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: -0.5,
    color: '#FFFFFF',
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 18,
    fontWeight: '500',
    lineHeight: 20,
  },
  backLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  backText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
