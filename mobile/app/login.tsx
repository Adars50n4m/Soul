/**
 * Soul — Login Screen
 * Design: Exact teddy bear couple from reference + dark theme
 * Auth:   Supabase email/password + Google Sign-In
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  ActivityIndicator,
  Dimensions,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import Svg, { Circle, Path, Ellipse, G } from 'react-native-svg';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApp } from '../context/AppContext';
import { authService } from '../services/AuthService';
import { supabase } from '../config/supabase';
import { GlassView } from '../components/ui/GlassView';

// Enable LayoutAnimation for Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Color Theme ──────────────────────────────────────────────────────
const STROKE = '#3A2B24';
const C = {
  bg:           '#000000',
  card:         'rgba(26, 26, 28, 0.40)',
  cardBorder:   'rgba(255, 255, 255, 0.10)',
  accent:       '#BC002A',
  accentDark:   '#9B0022',
  input:        '#222224',
  inputBorder:  '#3A3A3C',
  inputFocus:   '#BC002A',
  text:         '#FFFFFF',
  textMuted:    '#9CA3AF',
  textSub:      '#999999',
};

export default function LoginScreen() {
  const router = useRouter();
  const { setSession, currentUser, activeTheme } = useApp();
  
  // Dynamic theme colors
  const themeAccent = activeTheme.primary;

  // ── Core Auth State ───────────────────────────────────────────
  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [showPassword, setShowPwd]      = useState(false);
  const [isEmailFocused, setEmailFocus] = useState(false);
  const [isPassFocused, setPassFocus]   = useState(false);
  const [status, setStatus]             = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');

  // ── Integrated Signup State ─────────────────────────────────────
  const [isLogin, setIsLogin]           = useState(true);
  const [username, setUsername]         = useState('');
  const [confirmPassword, setConfirm]   = useState('');
  const [showConfirm, setShowConfirm]   = useState(false);
  const [isUsernameFocused, setUserFocus] = useState(false);
  const [isConfirmFocused, setConfFocus] = useState(false);
  const [isRealEmailFocused, setRealEmailFocus] = useState(false); // For signup email field
  const [emailSignup, setEmailSignup]   = useState('');
  const [usernameState, setUsernameState] = useState<'idle'|'checking'|'available'|'taken'|'invalid'>('idle');
  const [usernameMessage, setUsernameMessage] = useState('');
  const [error, setError]               = useState('');

  // ── Multi-Step Signup State ─────────────────────────────────────
  const [signupStep, setSignupStep]     = useState<'email' | 'otp' | 'setup'>('email');
  const [otp, setOtp]                   = useState('');
  const [isOtpFocused, setOtpFocus]     = useState(false);

  // ── Forgot Password State ──────────────────────────────────────
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [isResetSuccess, setIsResetSuccess]     = useState(false);
  
  const isAnyFocused = isEmailFocused || isPassFocused || isUsernameFocused || isConfirmFocused || isRealEmailFocused || isOtpFocused;

  const toggleMode = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsLogin(!isLogin);
    setIsForgotPassword(false);
    setIsResetSuccess(false);
    setSignupStep('email');
    setError('');
    setStatus('idle');
  };

  const toggleForgotPassword = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsForgotPassword(!isForgotPassword);
    setIsResetSuccess(false);
    setError('');
    setStatus('idle');
  };

  // ── Animated Values ──────────────────────────────────────────────
  const jumpY      = useRef(new Animated.Value(0)).current;
  const shakeX     = useRef(new Animated.Value(0)).current;
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartFloat = useRef(new Animated.Value(0)).current;
  const boyBreathe = useRef(new Animated.Value(0)).current;
  const girlBreathe = useRef(new Animated.Value(0)).current;
  const floatY = useRef(new Animated.Value(0)).current;

  // ── Hello wave state (random idle animation) ─────────────────────
  const [waveState, setWaveState] = useState<{
    bear: 'boy' | 'girl' | 'both' | null;
    arm: number;
    bounce: number;
  }>({ bear: null, arm: 0, bounce: 0 });

  // Redirect if already logged in
  useEffect(() => {
    // Safety check for OAuth redirection
    authService.maybeCompleteAuthSession();
    
    if (currentUser && currentUser.username && !currentUser.username.startsWith('user_')) {
      router.replace('/(tabs)');
    }
  }, [currentUser]);

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

    // Smooth floating motion
    Animated.loop(
      Animated.sequence([
        Animated.timing(floatY, { toValue: -8, duration: 2200, useNativeDriver: true }),
        Animated.timing(floatY, { toValue: 0,  duration: 2200, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  // ── Random "hello" wave when form is blank and idle ──────────────
  const waveTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const waveActiveRef = useRef(false);

  const clearWaveTimers = useCallback(() => {
    waveTimersRef.current.forEach(t => clearTimeout(t));
    waveTimersRef.current = [];
  }, []);

  const playWave = useCallback((bear: 'boy' | 'girl' | 'both') => {
    if (waveActiveRef.current) return;
    waveActiveRef.current = true;
    // PEAK=155 → boy lAngle = 170°, girl rAngle = -170° — exact mirror of the
    // covering pose (-170°/170°). At this angle the raised hand lands right
    // beside the outer eye (temple/ear area), reading as "hello".
    // DIP=135 gives a 20° wave oscillation at the top.
    const PEAK = 155;
    const DIP = 135;
    const frames = [
      { t: 0,    arm: 0,    bounce: 0  },
      { t: 80,   arm: 55,   bounce: -2 },
      { t: 170,  arm: 120,  bounce: -4 },
      { t: 260,  arm: PEAK, bounce: -5 },  // raised up
      { t: 370,  arm: DIP,  bounce: -4 },  // wave dip 1
      { t: 470,  arm: PEAK, bounce: -5 },  // wave up 1
      { t: 570,  arm: DIP,  bounce: -4 },  // wave dip 2
      { t: 670,  arm: PEAK, bounce: -5 },  // wave up 2
      { t: 770,  arm: DIP,  bounce: -4 },  // wave dip 3
      { t: 870,  arm: PEAK, bounce: -5 },  // wave up 3
      { t: 960,  arm: 90,   bounce: -3 },
      { t: 1080, arm: 35,   bounce: -1 },
      { t: 1200, arm: 0,    bounce: 0  },
    ];
    frames.forEach(f => {
      const id = setTimeout(() => {
        setWaveState({ bear, arm: f.arm, bounce: f.bounce });
      }, f.t);
      waveTimersRef.current.push(id);
    });
    const endId = setTimeout(() => {
      setWaveState({ bear: null, arm: 0, bounce: 0 });
      waveActiveRef.current = false;
    }, 1300);
    waveTimersRef.current.push(endId);
  }, []);

  useEffect(() => {
    const isBlank =
      !email && !password && !username && !confirmPassword &&
      !emailSignup && !otp;
    // Wave as long as form is blank and not in password-focus mode (where the
    // bears are covering/peeking — incompatible with waving).
    const canWave =
      isBlank && !isPassFocused && !isConfirmFocused &&
      status === 'idle' && !isForgotPassword;

    if (!canWave) {
      clearWaveTimers();
      waveActiveRef.current = false;
      setWaveState({ bear: null, arm: 0, bounce: 0 });
      return;
    }

    let cancelled = false;
    let isFirst = true;
    const schedule = () => {
      const delay = isFirst
        ? 1200 + Math.random() * 1200  // 1.2s – 2.4s first time
        : 2800 + Math.random() * 3200; // 2.8s – 6s after
      isFirst = false;
      const id = setTimeout(() => {
        if (cancelled) return;
        // 25% chance both bears wave together, otherwise random solo wave.
        const r = Math.random();
        const bear: 'boy' | 'girl' | 'both' =
          r < 0.25 ? 'both' : r < 0.625 ? 'boy' : 'girl';
        playWave(bear);
        schedule();
      }, delay);
      waveTimersRef.current.push(id);
    };
    schedule();

    return () => {
      cancelled = true;
      clearWaveTimers();
    };
  }, [email, password, username, confirmPassword, emailSignup, otp, isPassFocused, isConfirmFocused, status, isForgotPassword, clearWaveTimers, playWave]);

  // Status animations
  useEffect(() => {
    if (status === 'success') {
      Animated.sequence([
        Animated.timing(jumpY, { toValue: -18, duration: 220, useNativeDriver: true }),
        Animated.spring(jumpY, { toValue: 0, useNativeDriver: true, tension: 180, friction: 7 }),
      ]).start();
      Animated.spring(heartScale, { toValue: 1, tension: 220, friction: 5, useNativeDriver: true }).start();
      Animated.loop(
        Animated.sequence([
          Animated.timing(heartFloat, { toValue: -12, duration: 900, useNativeDriver: true }),
          Animated.timing(heartFloat, { toValue: 0,   duration: 900, useNativeDriver: true }),
        ])
      ).start();
      setTimeout(() => {
        Animated.timing(heartScale, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      }, 3000);
    } else if (status === 'fail') {
      Animated.sequence([
        Animated.timing(shakeX, { toValue: -9, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue:  9, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: -6, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue:  6, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue:  0, duration: 80, useNativeDriver: true }),
      ]).start();
      const t = setTimeout(() => setStatus('idle'), 2000);
      return () => clearTimeout(t);
    }
  }, [status]);

  // ── Username Availability Check ──────────────────────────────
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLogin) return;
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
  }, [username, isLogin]);

  // ── Auth handlers ────────────────────────────────────────────────
  const syncAuthenticatedUser = async (fallbackUserId?: string) => {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user?.id || fallbackUserId;
    if (!userId) {
      return false;
    }
    await setSession(userId);
    return true;
  };

  const handleSubmit = async () => {
    if (status === 'loading') return;
    setError('');

    if (isLogin) {
      if (isForgotPassword) {
        if (!email.trim()) { setError('Email or Soul Id is required'); setStatus('fail'); return; }
        setStatus('loading');
        const res = await authService.sendPasswordResetEmail(email);
        if (res.success) {
          setIsResetSuccess(true);
          setStatus('idle');
        } else {
          setError(res.error || 'Failed to send reset link');
          setStatus('fail');
        }
        return;
      }

      if (!email.trim() || !password.trim()) { setStatus('fail'); return; }
      setStatus('loading');
      const result = await authService.signInWithPassword(email, password);
      if (result.success) {
        const synced = await syncAuthenticatedUser(result.user?.id);
        if (!synced) {
          setError('Login succeeded but session sync failed. Please try again.');
          setStatus('fail');
          return;
        }
        setStatus('success');
        setTimeout(() => router.replace('/(tabs)'), 1500);
      } else {
        setError(result.error || 'Login failed');
        setStatus('fail');
      }
    } else {
      if (signupStep === 'email') {
        if (!emailSignup.trim()) { setError('Email is required'); setStatus('fail'); return; }
        setStatus('loading');
        const res = await authService.sendOTP(emailSignup);
        if (res.success) {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setSignupStep('otp');
          setStatus('idle');
        } else {
          setError(res.error || 'Failed to send OTP');
          setStatus('fail');
        }
      } 
      else if (signupStep === 'otp') {
        if (otp.length < 6) { setError('Enter 6-digit code'); setStatus('fail'); return; }
        setStatus('loading');
        const res = await authService.verifyOTP(emailSignup, otp);
        if (res.success) {
          const synced = await syncAuthenticatedUser(res.user?.id);
          if (!synced) {
            setError('Verification succeeded but session sync failed. Please try again.');
            setStatus('fail');
            return;
          }
          if (res.isNewUser) {
            // Let the global _layout.tsx handle the redirect to /username-setup
            setStatus('success');
          } else {
            setStatus('success');
            setTimeout(() => router.replace('/(tabs)'), 1500);
          }
        } else {
          setError(res.error || 'Verification failed');
          setStatus('fail');
        }
      }
    }
  };

  const handleGoogleSignIn = async () => {
    if (status === 'loading') return;
    setError('');
    setStatus('loading');
    const result = await authService.signInWithGoogle();
    if (result.success) {
      const synced = await syncAuthenticatedUser(result.user?.id);
      if (!synced) {
        setError('Google sign-in succeeded but session sync failed. Please try again.');
        setStatus('fail');
        return;
      }
      setStatus('success');
      // If result.isNewUser is true, the _layout.tsx auth guard will automatically 
      // see the user session and redirect them to /username-setup.
      if (!result.isNewUser) {
        setTimeout(() => router.replace('/(tabs)'), 1000);
      }
    } else {
      setError(result.error || 'Google Sign-In failed');
      setStatus('fail');
    }
  };

  const trackLen = isEmailFocused ? email.length : (isPassFocused && showPassword ? password.length : 0);
  const eyeXOffset = (isEmailFocused || (isPassFocused && showPassword)) ? (Math.min(trackLen / 25, 1) * 6) - 3 : 0;
  const eyeYOffset = status === 'fail' ? 3 : (isEmailFocused || (isPassFocused && showPassword)) ? 2 : 0;
  const headXOffset = (isEmailFocused || (isPassFocused && showPassword)) ? (Math.min(trackLen / 25, 1) * 10) - 5 : 0;

  const headPath = (cx: number, cy: number) => `M ${cx} ${cy-50} C ${cx+45} ${cy-50},${cx+72} ${cy-20},${cx+72} ${cy+15} C ${cx+72} ${cy+55},${cx+40} ${cy+65},${cx} ${cy+65} C ${cx-40} ${cy+65},${cx-72} ${cy+55},${cx-72} ${cy+15} C ${cx-72} ${cy-20},${cx-45} ${cy-50},${cx} ${cy-50} Z`;

  const renderMouth = (cx: number, cy: number) => {
    const mY = cy + 18;
    if (status === 'fail') return <Path d={`M ${cx-8} ${mY+6} Q ${cx} ${mY} ${cx+8} ${mY+6}`} fill="none" stroke={STROKE} strokeWidth="4" strokeLinecap="round" />;
    if (isPassFocused && !showPassword) return <Path d={`M ${cx-4} ${mY} Q ${cx} ${mY+2} ${cx+4} ${mY}`} fill="none" stroke={STROKE} strokeWidth="4" strokeLinecap="round" />;
    let h = status === 'success' ? 16 : 12;
    if (isEmailFocused || (isPassFocused && showPassword)) h = 6 + (trackLen % 3) * 3;
    return (
      <G>
        <Path d={`M ${cx-7} ${mY} Q ${cx} ${mY+2} ${cx+7} ${mY} C ${cx+7} ${mY+h},${cx-7} ${mY+h},${cx-7} ${mY} Z`} fill={STROKE} stroke={STROKE} strokeWidth="3" strokeLinejoin="round" />
        <Path d={`M ${cx-4} ${mY+h*0.3} C ${cx-4} ${mY+h*0.8},${cx+4} ${mY+h*0.8},${cx+4} ${mY+h*0.3} Z`} fill="#FF94A8" />
      </G>
    );
  };

  const bears = [
    { id: 'boy',  cx: 145, cy: 90, color: '#FFFFFF', snout: '#FFF0F5', cheek: '#FFCAD6', peekArm: 'right' },
    { id: 'girl', cx: 255, cy: 90, color: '#D69E71', snout: '#F0C4A5', cheek: '#F08B8B', peekArm: 'left'  },
  ];

  const covering = isPassFocused && !showPassword;
  const peeking  = isPassFocused && showPassword;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
        style={[s.kav, isAnyFocused && { paddingTop: Platform.OS === 'ios' ? 120 : 140 }, { backgroundColor: activeTheme.background }]}
      >
        <Animated.View style={[s.bearsWrap, { transform: [{ translateY: Animated.add(jumpY, floatY) }, { translateX: shakeX }] }]}>
          <Svg width="400" height="240" viewBox="0 0 400 300">
            {bears.map(({ id, cx, cy, color, snout, cheek, peekArm }) => {
              const thisBearWaves =
                (waveState.bear === id || waveState.bear === 'both') && waveState.arm > 0;
              // Boy (screen left) waves his LEFT arm UP-OUTWARD (toward screen left).
              // Girl (screen right) waves her RIGHT arm UP-OUTWARD (toward screen right).
              // Peak angle = 170°/-170°, mirroring the covering pose but on the outer side.
              const waveLeft  = thisBearWaves && id === 'boy'  ? waveState.arm : 0;
              const waveRight = thisBearWaves && id === 'girl' ? waveState.arm : 0;

              const lAngle = (covering || (peeking && peekArm !== 'left'))  ? -170 : 15  + waveLeft;
              const rAngle = (covering || (peeking && peekArm !== 'right')) ?  170 : -15 - waveRight;
              const bearY  = thisBearWaves ? waveState.bounce : 0;

              // Long arm when covering/peeking OR waving — otherwise short resting arm.
              const useLongLeft  = covering || (peeking && peekArm !== 'left')  || (thisBearWaves && id === 'boy');
              const useLongRight = covering || (peeking && peekArm !== 'right') || (thisBearWaves && id === 'girl');
              const leftArmPath  = useLongLeft
                ? `M 14 0 C 22 30,20 65,10 80 A 15 15 0 0 1 -24 70 C -22 35,-20 20,-16 0`
                : `M 12 0 C 18 15,16 35,8 45 A 12 12 0 0 1 -18 38 C -16 20,-14 10,-10 0`;
              const rightArmPath = useLongRight
                ? `M -14 0 C -22 30,-20 65,-10 80 A 15 15 0 0 0 24 70 C 22 35,20 20,16 0`
                : `M -12 0 C -18 15,-16 35,-8 45 A 12 12 0 0 0 18 38 C 16 20,14 10,10 0`;
              return (
                <G key={id} y={bearY}>
                  <Ellipse cx={cx-24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
                  <Ellipse cx={cx+24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
                  <Path d={`M ${cx-34} ${cy+25} C ${cx-65} ${cy+60},${cx-60} ${cy+135},${cx} ${cy+135} C ${cx+60} ${cy+135},${cx+65} ${cy+60},${cx+34} ${cy+25} Z`} fill={color} stroke={STROKE} strokeWidth="5" />
                  <G translateX={headXOffset}>
                    <Circle cx={cx-48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
                    <Circle cx={cx+48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
                    <Path d={headPath(cx, cy)} fill={color} stroke={STROKE} strokeWidth="5" />
                    <Ellipse cx={cx} cy={cy+19} rx="22" ry="16" fill={snout} />
                    <Ellipse cx={cx-42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
                    <Ellipse cx={cx+42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
                    <Circle cx={cx-24+eyeXOffset} cy={cy+5+eyeYOffset} r="6.5" fill={STROKE} />
                    <Circle cx={cx+24+eyeXOffset} cy={cy+5+eyeYOffset} r="6.5" fill={STROKE} />
                    <Path d={`M ${cx-2} ${cy+11} Q ${cx} ${cy+13} ${cx+2} ${cy+11} Z`} fill={STROKE} stroke={STROKE} strokeWidth="2" />
                    {renderMouth(cx, cy)}
                  </G>
                  <G transform={`rotate(${lAngle}, ${cx-40}, ${cy+60}) translate(${cx-40}, ${cy+60})`}>
                    <Path d={leftArmPath} fill={color} stroke={STROKE} strokeWidth="5" />
                  </G>
                  <G transform={`rotate(${rAngle}, ${cx+40}, ${cy+60}) translate(${cx+40}, ${cy+60})`}>
                    <Path d={rightArmPath} fill={color} stroke={STROKE} strokeWidth="5" />
                  </G>
                </G>
              );
            })}
          </Svg>
        </Animated.View>

        <View style={s.card}>
          <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          <Text style={[s.title, { color: themeAccent }]}>
            {isForgotPassword ? 'Reset Soul' : (isLogin ? 'Soul' : (signupStep === 'otp' ? 'Verify Email' : (signupStep === 'setup' ? 'Setup Account' : 'Create Soul Id')))}
          </Text>
          <Text style={s.subtitle}>
            {isForgotPassword ? (isResetSuccess ? "Recovery link sent!" : "Enter email to recover") : (isLogin ? 'Soul for Soulmates' : (signupStep === 'otp' ? 'Check email for code' : 'Set your unique identity'))}
          </Text>

          {!!error && <Text style={s.err}>{error}</Text>}

          {isLogin ? (
            <>
              {!isResetSuccess && (
                <View style={[s.inputWrap, isEmailFocused && { borderColor: themeAccent }]}>
                  <Feather name={isForgotPassword ? "mail" : "user"} size={20} color={isEmailFocused ? themeAccent : '#666'} style={s.inputIcon} />
                  <TextInput style={s.input} placeholder={isForgotPassword ? "Email or Soul Id" : "Soul Id or Email"} placeholderTextColor="#666" value={email} onChangeText={setEmail} onFocus={() => setEmailFocus(true)} onBlur={() => setEmailFocus(false)} autoCapitalize="none" />
                </View>
              )}
              {!isForgotPassword && (
                <View style={[s.inputWrap, isPassFocused && { borderColor: themeAccent }, { marginBottom: 28 }]}>
                  <Feather name="lock" size={20} color={isPassFocused ? themeAccent : '#666'} style={s.inputIcon} />
                  <TextInput style={s.input} placeholder="Secret Password" placeholderTextColor="#666" value={password} onChangeText={setPassword} onFocus={() => setPassFocus(true)} onBlur={() => setPassFocus(false)} secureTextEntry={!showPassword} />
                  <TouchableOpacity onPress={() => setShowPwd(p => !p)}><Feather name={showPassword ? 'eye' : 'eye-off'} size={20} color={isPassFocused ? themeAccent : "#666"} /></TouchableOpacity>
                </View>
              )}
            </>
          ) : (
            <>
              {signupStep === 'email' && (
                <View style={[s.inputWrap, isRealEmailFocused && { borderColor: themeAccent }, { marginBottom: 20 }]}>
                  <Feather name="mail" size={20} color={isRealEmailFocused ? themeAccent : '#666'} style={s.inputIcon} />
                  <TextInput style={s.input} placeholder="Email" placeholderTextColor="#666" value={emailSignup} onChangeText={setEmailSignup} onFocus={() => setRealEmailFocus(true)} onBlur={() => setRealEmailFocus(false)} autoCapitalize="none" keyboardType="email-address" />
                </View>
              )}
              {signupStep === 'otp' && (
                <View style={[s.inputWrap, isOtpFocused && { borderColor: themeAccent }, { marginBottom: 20 }]}>
                  <Feather name="shield" size={20} color={isOtpFocused ? themeAccent : '#666'} style={s.inputIcon} />
                  <TextInput style={[s.input, { letterSpacing: 8 }]} placeholder="◯ ◯ ◯ ◯ ◯ ◯" placeholderTextColor="#444" value={otp} onChangeText={(v) => setOtp(v.replace(/[^0-9]/g, ''))} onFocus={() => setOtpFocus(true)} onBlur={() => setOtpFocus(false)} keyboardType="number-pad" maxLength={6} />
                </View>
              )}
              {signupStep === 'setup' && (
                <>
                  <View style={[s.inputWrap, isUsernameFocused && { borderColor: themeAccent }]}>
                    <Feather name="at-sign" size={20} color={isUsernameFocused ? themeAccent : '#666'} style={s.inputIcon} />
                    <TextInput style={s.input} placeholder="Username" placeholderTextColor="#666" value={username} onChangeText={setUsername} onFocus={() => setUserFocus(true)} onBlur={() => setUserFocus(false)} autoCapitalize="none" />
                  </View>
                  <View style={[s.inputWrap, isPassFocused && { borderColor: themeAccent }]}>
                    <Feather name="lock" size={20} color={isPassFocused ? themeAccent : '#666'} style={s.inputIcon} />
                    <TextInput style={s.input} placeholder="Password" placeholderTextColor="#666" value={password} onChangeText={setPassword} onFocus={() => setPassFocus(true)} onBlur={() => setPassFocus(false)} secureTextEntry={!showPassword} />
                  </View>
                  <View style={[s.inputWrap, isConfirmFocused && { borderColor: themeAccent }, { marginBottom: 28 }]}>
                    <Feather name="shield" size={20} color={isConfirmFocused ? themeAccent : '#666'} style={s.inputIcon} />
                    <TextInput style={s.input} placeholder="Confirm" placeholderTextColor="#666" value={confirmPassword} onChangeText={setConfirm} onFocus={() => setConfFocus(true)} onBlur={() => setConfFocus(false)} secureTextEntry={!showConfirm} />
                  </View>
                </>
              )}
            </>
          )}

          <TouchableOpacity style={[s.btn, { backgroundColor: themeAccent }]} onPress={isResetSuccess ? toggleForgotPassword : handleSubmit} disabled={status === 'loading'}>
            {status === 'loading' ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{isLogin ? (isForgotPassword ? 'Reset' : 'Login') : 'Next'}</Text>}
          </TouchableOpacity>

          {((isLogin && !isForgotPassword) || (!isLogin && signupStep === 'email')) && (
            <>
              <View style={s.dividerRow}>
                <View style={s.dividerLine} />
                <Text style={s.dividerText}>OR</Text>
                <View style={s.dividerLine} />
              </View>

              <TouchableOpacity style={s.googleBtn} onPress={handleGoogleSignIn} disabled={status === 'loading'} activeOpacity={0.8}>
                <Svg width={20} height={20} viewBox="0 0 48 48">
                  <Path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <Path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <Path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <Path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  <Path fill="none" d="M0 0h48v48H0z" />
                </Svg>
                <Text style={s.googleBtnText}>Continue with Google</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={s.footer}>
            <TouchableOpacity onPress={toggleMode}><Text style={[s.footerAccent, { color: themeAccent }]}>{isLogin ? 'Create Soul Id' : 'Login'}</Text></TouchableOpacity>
            {!isLogin && signupStep === 'email' && <TouchableOpacity onPress={toggleForgotPassword}><Text style={s.footerMuted}>Forgot?</Text></TouchableOpacity>}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  kav: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  bearsWrap: { width: 400, height: 170, alignItems: 'center', marginBottom: -50 },
  card: { width: '100%', backgroundColor: 'rgba(26, 26, 28, 0.4)', borderRadius: 40, padding: 28, overflow: 'hidden' },
  title: { fontSize: 38, fontWeight: '900', textAlign: 'center', color: '#FFFFFF' },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center', marginBottom: 26 },
  err: { color: '#FF6B6B', textAlign: 'center', marginBottom: 12 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#222', borderRadius: 16, borderWidth: 1, borderColor: '#333', paddingHorizontal: 16, height: 56, marginBottom: 14 },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, color: '#fff', fontSize: 15 },
  btn: { borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 22 },
  footerMuted: { color: '#9CA3AF', fontSize: 13 },
  footerAccent: { fontSize: 13, fontWeight: '700' },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 18,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  dividerText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#FFFFFF',
  },
  googleBtnText: {
    color: '#1F1F1F',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
