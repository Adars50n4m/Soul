import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
} from 'react-native';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import Animated, { SharedTransition, withTiming, Easing } from 'react-native-reanimated';
import { useApp } from '../context/AppContext';
import { GlassView } from '../components/ui/GlassView';
import { SoulLoader } from '../components/ui/SoulLoader';
import { authService } from '../services/AuthService';
import { LinearGradient } from 'expo-linear-gradient';

type AvailabilityState = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

const onboardingCardTransition = SharedTransition.custom((values) => {
  'worklet';
  return {
    width: withTiming(values.targetWidth, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
    height: withTiming(values.targetHeight, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
    originX: withTiming(values.targetOriginX, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
    originY: withTiming(values.targetOriginY, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
    borderRadius: withTiming(values.targetBorderRadius, { duration: 360, easing: Easing.inOut(Easing.cubic) }),
  };
});

const onboardingHeroTransition = SharedTransition.custom((values) => {
  'worklet';
  return {
    width: withTiming(values.targetWidth, { duration: 300, easing: Easing.out(Easing.cubic) }),
    height: withTiming(values.targetHeight, { duration: 300, easing: Easing.out(Easing.cubic) }),
    originX: withTiming(values.targetOriginX, { duration: 300, easing: Easing.out(Easing.cubic) }),
    originY: withTiming(values.targetOriginY, { duration: 300, easing: Easing.out(Easing.cubic) }),
  };
});

function getPasswordStrength(password: string): {
  label: 'Too short' | 'Weak' | 'Fair' | 'Strong';
  score: number;
  color: string;
} {
  if (password.length < 6) return { label: 'Too short', score: 0, color: '#FF4444' };

  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const map = [
    { label: 'Weak' as const, color: '#FF6B35' },
    { label: 'Fair' as const, color: '#F5A623' },
    { label: 'Fair' as const, color: '#F5A623' },
    { label: 'Strong' as const, color: '#45D483' },
  ];

  return { label: map[score].label, score, color: map[score].color };
}

export default function UsernameSetupScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ oauthMode?: string; username?: string; password?: string }>();
  const { oauthMode } = params;
  const isOauthMode = oauthMode === 'true';
  const { activeTheme, logout } = useApp();
  const themeAccent = activeTheme.primary;

  const [username, setUsername] = useState(params.username ?? '');
  const [usernameState, setUsernameState] = useState<AvailabilityState>('idle');
  const [usernameMessage, setUsernameMessage] = useState('');

  const [password, setPassword] = useState(params.password ?? '');
  const [confirmPassword, setConfirmPassword] = useState(params.password ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const strength = getPasswordStrength(password);

  useEffect(() => {
    if (typeof params.username === 'string') setUsername(params.username);
    if (typeof params.password === 'string') {
      setPassword(params.password);
      setConfirmPassword(params.password);
    }
  }, [params.username, params.password]);

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
          setUsernameMessage(`@${username.toLowerCase()} is available`);
        } else {
          setUsernameState('taken');
          setUsernameMessage('This username is already taken.');
        }
      } catch {
        setUsernameState('invalid');
        setUsernameMessage('Error checking availability.');
      }
    }, 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [username]);

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

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      router.push({
        pathname: '/profile-setup',
        params: { username, password, oauthMode: isOauthMode ? 'true' : 'false' },
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#050505" />

      <View style={styles.backgroundBase} />
      <LinearGradient
        colors={['rgba(194, 0, 47, 0.22)', 'rgba(194, 0, 47, 0.05)', 'transparent']}
        start={{ x: 1, y: 0 }}
        end={{ x: 0.1, y: 0.8 }}
        style={styles.backgroundGlowTop}
      />
      <LinearGradient
        colors={['rgba(17, 136, 255, 0.14)', 'rgba(17, 136, 255, 0.04)', 'transparent']}
        start={{ x: 0, y: 1 }}
        end={{ x: 0.7, y: 0.2 }}
        style={styles.backgroundGlowBottom}
      />
      <View style={styles.gridLineVertical} />
      <View style={styles.gridLineHorizontal} />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Animated.View
          sharedTransitionTag="onboarding-hero-block"
          sharedTransitionStyle={onboardingHeroTransition}
          style={styles.heroBlock}
        >
          <View style={styles.stepChip}>
            <Text style={[styles.stepChipText, { color: themeAccent }]}>STEP 1 / 2</Text>
          </View>
          <Text style={styles.heroTitle}>Claim your Soul ID</Text>
          <Text style={styles.heroSubtitle}>
            Set the public handle people will use to find you. Keep it clean, memorable, and yours.
          </Text>
        </Animated.View>

        <Animated.View
          sharedTransitionTag="onboarding-setup-card"
          sharedTransitionStyle={onboardingCardTransition}
          style={styles.sharedCardWrap}
        >
        <GlassView intensity={Platform.OS === 'ios' ? 90 : 65} tint="dark" style={styles.card}>
          <View style={styles.cardTopRow}>
            <TouchableOpacity onPress={handleBack} style={styles.backButton} activeOpacity={0.85}>
              <Feather name="arrow-left" size={18} color={themeAccent} />
              <Text style={[styles.backButtonText, { color: themeAccent }]}>Back</Text>
            </TouchableOpacity>

            <View style={styles.progressRail}>
              <View style={[styles.progressFill, { backgroundColor: themeAccent }]} />
            </View>
          </View>

          {isOauthMode && (
            <View style={styles.oauthBanner}>
              <View style={[styles.oauthIconWrap, { backgroundColor: `${themeAccent}22` }]}>
                <MaterialIcons name="verified-user" size={16} color={themeAccent} />
              </View>
              <Text style={styles.oauthBannerText}>
                Google connected. Add a password too so you can log in with your Soul ID later.
              </Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.label}>Username</Text>
            <View style={[
              styles.inputShell,
              usernameState === 'available' && styles.inputSuccess,
              (usernameState === 'taken' || usernameState === 'invalid') && styles.inputError,
            ]}>
              <View style={styles.inputPrefix}>
                <Text style={[styles.inputPrefixText, { color: themeAccent }]}>@</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder="e.g. alex_99"
                placeholderTextColor="#5F6072"
                autoCapitalize="none"
                autoCorrect={false}
                value={username}
                onChangeText={setUsername}
              />
              <View style={styles.statusSlot}>
                {usernameState === 'checking' ? (
                  <SoulLoader size={28} />
                ) : usernameState === 'available' ? (
                  <MaterialIcons name="north-east" size={18} color="#45D483" />
                ) : (usernameState === 'taken' || usernameState === 'invalid') ? (
                  <MaterialIcons name="close" size={18} color="#FF6B6B" />
                ) : null}
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

            <View style={styles.rulesGrid}>
              <Text style={styles.rule}>3–20 characters</Text>
              <Text style={styles.rule}>letters, numbers, . and _ only</Text>
              <Text style={styles.rule}>cannot start with . or _</Text>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Password</Text>
            <View style={styles.inputShell}>
              <View style={styles.inputPrefix}>
                <MaterialIcons name="lock-outline" size={18} color="#7E7F91" />
              </View>
              <TextInput
                style={styles.input}
                placeholder="At least 8 characters"
                placeholderTextColor="#5F6072"
                secureTextEntry={!showPassword}
                value={password}
                onChangeText={setPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity onPress={() => setShowPassword(v => !v)} style={styles.eyeButton}>
                <Feather name={showPassword ? 'eye-off' : 'eye'} size={18} color="#8F90A3" />
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
                        i < strength.score ? { backgroundColor: strength.color } : styles.strengthBarIdle,
                      ]}
                    />
                  ))}
                </View>
                <Text style={[styles.strengthLabel, { color: strength.color }]}>{strength.label}</Text>
              </View>
            )}
          </View>

          <View style={styles.section}>
            <Text style={styles.label}>Confirm password</Text>
            <View style={[
              styles.inputShell,
              confirmPassword.length > 0 && confirmPassword === password && styles.inputSuccess,
              confirmPassword.length > 0 && confirmPassword !== password && styles.inputError,
            ]}>
              <View style={styles.inputPrefix}>
                <MaterialIcons name="lock-outline" size={18} color="#7E7F91" />
              </View>
              <TextInput
                style={styles.input}
                placeholder="Repeat password"
                placeholderTextColor="#5F6072"
                secureTextEntry={!showConfirm}
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity onPress={() => setShowConfirm(v => !v)} style={styles.eyeButton}>
                <Feather name={showConfirm ? 'eye-off' : 'eye'} size={18} color="#8F90A3" />
              </TouchableOpacity>
            </View>
            {confirmPassword.length > 0 && confirmPassword !== password && (
              <Text style={[styles.fieldHint, styles.hintRed]}>Passwords don’t match</Text>
            )}
          </View>

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: themeAccent }, loading && styles.buttonDisabled]}
            onPress={handleNext}
            disabled={loading}
            activeOpacity={0.88}
          >
            {loading ? (
              <SoulLoader size={38} />
            ) : (
              <Text style={styles.primaryButtonText}>Continue</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footerNote}>
            You can update your display name later. Your Soul ID should stay sharp and recognizable.
          </Text>
        </GlassView>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#050505',
  },
  backgroundBase: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#050505',
  },
  backgroundGlowTop: {
    position: 'absolute',
    top: -30,
    right: -40,
    width: 280,
    height: 280,
    borderRadius: 140,
  },
  backgroundGlowBottom: {
    position: 'absolute',
    left: -60,
    bottom: 120,
    width: 260,
    height: 260,
    borderRadius: 130,
  },
  gridLineVertical: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '82%',
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  gridLineHorizontal: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 180,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 22,
    paddingTop: 74,
    paddingBottom: 28,
    justifyContent: 'center',
  },
  heroBlock: {
    marginBottom: 18,
    paddingHorizontal: 10,
    alignItems: 'center',
  },
  stepChip: {
    alignSelf: 'center',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginBottom: 12,
  },
  stepChipText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 26,
    lineHeight: 28,
    fontWeight: '900',
    letterSpacing: -1,
    marginBottom: 10,
    textAlign: 'center',
  },
  heroSubtitle: {
    color: 'rgba(255,255,255,0.66)',
    fontSize: 13,
    lineHeight: 19,
    maxWidth: '88%',
    textAlign: 'center',
  },
  card: {
    borderRadius: 34,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    backgroundColor: 'rgba(16,16,18,0.58)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.34,
    shadowRadius: 28,
    elevation: 14,
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
  },
  sharedCardWrap: {
    width: '100%',
    maxWidth: 860,
    alignSelf: 'center',
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  progressRail: {
    flex: 1,
    height: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  progressFill: {
    width: '50%',
    height: '100%',
    borderRadius: 999,
  },
  oauthBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 11,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    marginBottom: 14,
  },
  oauthIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  oauthBannerText: {
    flex: 1,
    color: '#D3D5E1',
    fontSize: 12,
    lineHeight: 17,
  },
  section: {
    marginBottom: 16,
  },
  label: {
    color: '#A8ABBE',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    borderRadius: 18,
    borderWidth: 1.5,
    borderColor: '#26283A',
    backgroundColor: 'rgba(15,15,25,0.92)',
    overflow: 'hidden',
  },
  inputPrefix: {
    width: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputPrefixText: {
    fontSize: 22,
    fontWeight: '800',
  },
  input: {
    flex: 1,
    color: '#F4F4F8',
    fontSize: 15,
    fontWeight: '600',
    paddingVertical: 14,
    paddingRight: 8,
  },
  statusSlot: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputSuccess: {
    borderColor: '#45D483',
  },
  inputError: {
    borderColor: '#FF6B6B',
  },
  fieldHint: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '600',
  },
  hintGreen: {
    color: '#45D483',
  },
  hintRed: {
    color: '#FF6B6B',
  },
  rulesGrid: {
    marginTop: 8,
    gap: 4,
  },
  rule: {
    color: '#6E7186',
    fontSize: 11,
    lineHeight: 15,
  },
  eyeButton: {
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  strengthBars: {
    flex: 1,
    flexDirection: 'row',
    gap: 5,
  },
  strengthBar: {
    flex: 1,
    height: 5,
    borderRadius: 999,
  },
  strengthBarIdle: {
    backgroundColor: '#26283A',
  },
  strengthLabel: {
    minWidth: 62,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '700',
  },
  errorText: {
    color: '#FF7777',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 10,
  },
  primaryButton: {
    minHeight: 54,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  footerNote: {
    color: '#7E8297',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 6,
  },
});
