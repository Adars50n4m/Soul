/**
 * SoulSync — Login Screen
 * Design: Exact teddy bear couple from reference + dark theme
 * Auth:   Supabase email/password + Google Sign-In
 */

import React, { useState, useRef, useEffect } from 'react';
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
  Keyboard,
} from 'react-native';
import Svg, { Circle, Path, Ellipse, G, Line } from 'react-native-svg';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useApp } from '../context/AppContext';
import { authService } from '../services/AuthService';
import { GlassView } from '../components/ui/GlassView';

// Enable LayoutAnimation for Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width: SCREEN_W } = Dimensions.get('window');

// ── Color Theme ──────────────────────────────────────────────────────
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

export default function LoginScreen() {
  const router = useRouter();
  const { login, setSession, currentUser } = useApp();

  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [isEmailFocused, setEmailFocus] = useState(false);
  const [isPassFocused, setPassFocus]   = useState(false);
  const [showPassword, setShowPwd]      = useState(false);
  const [status, setStatus]             = useState<'idle'|'loading'|'success'|'fail'>('idle');

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
  const bearScale = useRef(new Animated.Value(1)).current;
  const bearOpacity = useRef(new Animated.Value(1)).current;

  // Keyboard: shrink bears so they don't get cut by notch
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, () => {
      Animated.parallel([
        Animated.timing(bearScale, { toValue: 0.5, duration: 250, useNativeDriver: true }),
        Animated.timing(bearOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      Animated.parallel([
        Animated.timing(bearScale, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(bearOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    });
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  // Redirect if already logged in
  useEffect(() => {
    if (currentUser) router.replace('/(tabs)');
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
        heartFloat.stopAnimation();
        heartFloat.setValue(0);
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
  const handleSubmit = async () => {
    if (status === 'loading') return;
    setError('');

    if (isLogin) {
      if (isForgotPassword) {
        // ── Forgot Password Reset flow ──
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

      // ── Login Flow ──
      if (!email.trim() || !password.trim()) { setStatus('fail'); return; }
      setStatus('loading');
      const result = await authService.signInWithPassword(email, password);
      if (result.success && result.user) {
        await setSession(result.user.id);
        setStatus('success');
        setTimeout(() => router.replace('/(tabs)'), 1500);
      } else {
        setError(result.error || 'Login failed');
        setStatus('fail');
      }
    } else {
      // ── Signup Flow: Multi-Step ──
      
      if (signupStep === 'email') {
        // Step 1: Send OTP
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
        // Step 2: Verify OTP
        if (otp.length < 6) { setError('Enter 6-digit code'); setStatus('fail'); return; }
        setStatus('loading');
        const res = await authService.verifyOTP(emailSignup, otp);
        if (res.success) {
          if (res.isNewUser) {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setSignupStep('setup');
            setStatus('idle');
          } else {
            setStatus('success');
            setTimeout(() => router.replace('/(tabs)'), 1500);
          }
        } else {
          setError(res.error || 'Verification failed');
          setStatus('fail');
        }
      }
      else if (signupStep === 'setup') {
        // Step 3: Complete Setup
        if (!username || usernameState !== 'available') { setError('Choose a valid username'); setStatus('fail'); return; }
        if (password.length < 8) { setError('Password too short (8+)'); setStatus('fail'); return; }
        if (password !== confirmPassword) { setError('Passwords do not match'); setStatus('fail'); return; }

        setStatus('loading');
        // We use completeProfileSetup because verifyOTP already established a session
        const res = await authService.completeProfileSetup({
          username,
          password,
          displayName: username, // Default to username
        });

        if (res.success) {
          setStatus('success');
          setTimeout(() => router.replace('/(tabs)'), 1500);
        } else {
          setError(res.error || 'Setup failed');
          setStatus('fail');
        }
      }
    }
  };

  const handleLogin = handleSubmit; // Alias for backward compatibility if any

  const handleGoogleSignIn = async () => {
    if (status === 'loading') return;
    setStatus('loading');
    const result = await authService.signInWithGoogle();
    if (result.success) {
      setStatus('success');
      if (result.isNewUser) {
        // If it's a new user from Google, we jump to Setup step
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setIsLogin(false);
        setSignupStep('setup');
        setStatus('idle');
      }
      else setTimeout(() => router.replace('/(tabs)'), 1000);
    } else {
      setStatus('fail');
    }
  };

  // ── Dynamic tracking ──────────────────────────────────────────────
  const trackLen = isEmailFocused ? email.length
    : (isPassFocused && showPassword ? password.length : 0);

  // Eye movement (relative to head)
  const eyeXOffset = (isEmailFocused || (isPassFocused && showPassword))
    ? (Math.min(trackLen / 25, 1) * 6) - 3 : 0;
  const eyeYOffset = status === 'fail' ? 3
    : (isEmailFocused || (isPassFocused && showPassword)) ? 2 : 0;

  // Phase 22: Head tracking (entire face group moves)
  const headXOffset = (isEmailFocused || (isPassFocused && showPassword))
    ? (Math.min(trackLen / 25, 1) * 10) - 5 : 0;

  // ── SVG path helpers (exact from reference) ───────────────────────
  const headPath = (cx: number, cy: number) =>
    `M ${cx} ${cy-50} C ${cx+45} ${cy-50},${cx+72} ${cy-20},${cx+72} ${cy+15} C ${cx+72} ${cy+55},${cx+40} ${cy+65},${cx} ${cy+65} C ${cx-40} ${cy+65},${cx-72} ${cy+55},${cx-72} ${cy+15} C ${cx-72} ${cy-20},${cx-45} ${cy-50},${cx} ${cy-50} Z`;

  // Body starts wider (cx±40) to overlap with head bottom — no visible neck gap
  const bodyPath = (cx: number, cy: number) =>
    `M ${cx-40} ${cy+30} C ${cx-55} ${cy+80},${cx-50} ${cy+165},${cx-35} ${cy+175} L ${cx-2} ${cy+175} C ${cx} ${cy+165},${cx} ${cy+165},${cx+2} ${cy+175} L ${cx+35} ${cy+175} C ${cx+50} ${cy+165},${cx+55} ${cy+80},${cx+40} ${cy+30} Z`;

  const leftArm  = `M 16 0 C 24 30,22 65,10 85 A 18 18 0 0 1 -26 75 C -24 40,-20 20,-16 0`;
  const rightArm = `M -16 0 C -24 30,-22 65,-10 85 A 18 18 0 0 0 26 75 C 24 40,20 20,16 0`;

  // ── Mouth renderer (exact from reference) ─────────────────────────
  const renderMouth = (cx: number, cy: number) => {
    const mY = cy + 18;
    if (status === 'fail') {
      return <Path d={`M ${cx-8} ${mY+6} Q ${cx} ${mY} ${cx+8} ${mY+6}`} fill="none" stroke={STROKE} strokeWidth="4" strokeLinecap="round" />;
    }
    if (isPassFocused && !showPassword) {
      return <Path d={`M ${cx-4} ${mY} Q ${cx} ${mY+2} ${cx+4} ${mY}`} fill="none" stroke={STROKE} strokeWidth="4" strokeLinecap="round" />;
    }
    let h = status === 'success' ? 16 : 12;
    if (isEmailFocused || (isPassFocused && showPassword)) {
      h = 6 + (trackLen % 3) * 3;
    }
    return (
      <G>
        <Path d={`M ${cx-7} ${mY} Q ${cx} ${mY+2} ${cx+7} ${mY} C ${cx+7} ${mY+h},${cx-7} ${mY+h},${cx-7} ${mY} Z`} fill={STROKE} stroke={STROKE} strokeWidth="3" strokeLinejoin="round" />
        <Path d={`M ${cx-4} ${mY+h*0.3} C ${cx-4} ${mY+h*0.8},${cx+4} ${mY+h*0.8},${cx+4} ${mY+h*0.3} Z`} fill="#FF94A8" />
      </G>
    );
  };

  // ── Bear configs (Hug Pose) ─────────────────────────────────────────
  const bears = [
    { id: 'boy',  cx: 145, cy: 90, color: '#FFFFFF', snout: '#FFF0F5', cheek: '#FFCAD6', peekArm: 'right' },
    { id: 'girl', cx: 255, cy: 90, color: '#D69E71', snout: '#F0C4A5', cheek: '#F08B8B', peekArm: 'left'  },
  ];

  const covering = isPassFocused && !showPassword;
  const peeking  = isPassFocused && showPassword;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.kav}>

        {/* ── Bears SVG ─────────────────────────────────────── */}
        <Animated.View style={[s.bearsWrap, { opacity: bearOpacity, transform: [{ translateY: Animated.add(jumpY, floatY) }, { translateX: shakeX }, { scale: bearScale }] }]}>
          <Svg width="400" height="240" viewBox="0 0 400 300">
            {bears.map(({ id, cx, cy, color, snout, cheek, peekArm }) => {
              const isWhite = id === 'boy';
              const lAngle = (covering || (peeking && peekArm !== 'left'))  ? -170 : 15;
              const rAngle = (covering || (peeking && peekArm !== 'right')) ?  170 : -15;

              // Phase 23: Seamless Neck Integration (Visual Overflow Fix)
              // Narrowed top and lower start Y to stay hidden behind moving head
              const tummyPath = `M ${cx-34} ${cy+25} 
                C ${cx-65} ${cy+60},${cx-60} ${cy+135},${cx} ${cy+135} 
                C ${cx+60} ${cy+135},${cx+65} ${cy+60},${cx+34} ${cy+25} Z`;
              
              // Phase 24: Foot Spacing Refinement (Paas Paas Feet)
              // Feet brought closer together for a cuter look
              const FootL = () => <Ellipse cx={cx-24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />;
              const FootR = () => <Ellipse cx={cx+24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />;

              return (
                <G key={id}>
                  {/* Feet tucked behind/at edge of body */}
                  <FootL />
                  <FootR />

                  {/* Body (Tummy) */}
                  <Path d={tummyPath} fill={color} stroke={STROKE} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />

                  {/* Phase 22: Dynamic Head Group (Moves with typing) */}
                  <G translateX={headXOffset}>
                    {/* Ears */}
                    <Circle cx={cx-48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
                    <Circle cx={cx+48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />

                    {/* Head */}
                    <Path d={headPath(cx, cy)} fill={color} stroke={STROKE} strokeWidth="5" strokeLinejoin="round" />

                    {/* Snout */}
                    <Ellipse cx={cx} cy={cy+19} rx="22" ry="16" fill={snout} />

                    {/* Cheeks */}
                    <Ellipse cx={cx-42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
                    <Ellipse cx={cx+42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />

                    {/* Eyes */}
                    {status === 'success' ? (
                      <G>
                        <Path d={`M ${cx-32} ${cy+7} Q ${cx-24} ${cy-2} ${cx-16} ${cy+7}`} stroke={STROKE} strokeWidth="5" strokeLinecap="round" fill="transparent" />
                        <Path d={`M ${cx+16} ${cy+7} Q ${cx+24} ${cy-2} ${cx+32} ${cy+7}`} stroke={STROKE} strokeWidth="5" strokeLinecap="round" fill="transparent" />
                      </G>
                    ) : (
                      <G>
                        <Circle cx={cx-24+eyeXOffset} cy={cy+5+eyeYOffset} r="6.5" fill={STROKE} />
                        <Circle cx={cx-21.5+eyeXOffset} cy={cy+2.5+eyeYOffset} r="2" fill="#fff" />
                        <Circle cx={cx+24+eyeXOffset} cy={cy+5+eyeYOffset} r="6.5" fill={STROKE} />
                        <Circle cx={cx+26.5+eyeXOffset} cy={cy+2.5+eyeYOffset} r="2" fill="#fff" />
                      </G>
                    )}

                    {/* Nose */}
                    <Path d={`M ${cx-2} ${cy+11} Q ${cx} ${cy+13} ${cx+2} ${cy+11} Z`} fill={STROKE} stroke={STROKE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

                    {/* Mouth */}
                    {renderMouth(cx, cy)}
                  </G>


                  {/* Left arm */}
                  {(() => {
                    const lPath = covering
                      ? `M 14 0 C 22 30,20 65,10 80 A 15 15 0 0 1 -24 70 C -22 35,-20 20,-16 0` // Long
                      : `M 12 0 C 18 15,16 35,8 45 A 12 12 0 0 1 -18 38 C -16 20,-14 10,-10 0`;  // Short
                    return (
                      <G transform={`rotate(${lAngle}, ${cx-40}, ${cy+60})`}>
                        <G transform={`translate(${cx-40}, ${cy+60})`}>
                          <Path d={lPath} fill={color} stroke={STROKE} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
                        </G>
                      </G>
                    );
                  })()}

                  {/* Right arm */}
                  {(() => {
                    const rPath = covering
                      ? `M -14 0 C -22 30,-20 65,-10 80 A 15 15 0 0 0 24 70 C 22 35,20 20,16 0` // Long
                      : `M -12 0 C -18 15,-16 35,-8 45 A 12 12 0 0 0 18 38 C 16 20,14 10,10 0`;  // Short
                    return (
                      <G transform={`rotate(${rAngle}, ${cx+40}, ${cy+60})`}>
                        <G transform={`translate(${cx+40}, ${cy+60})`}>
                          <Path d={rPath} fill={color} stroke={STROKE} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
                        </G>
                      </G>
                    );
                  })()}

                </G>
              );
            })}
          </Svg>
        </Animated.View>



        {/* ── Form Card ─────────────────────────────────────────── */}
        <View style={s.card}>
          {/* Blur backdrop */}
          <GlassView 
            intensity={80} 
            tint="dark" 
            style={StyleSheet.absoluteFill} 
          />

          <Text style={s.title}>
            {isForgotPassword 
              ? 'Reset Soul' 
              : (isLogin ? 'Soul' : (signupStep === 'otp' ? 'Verify Email' : (signupStep === 'setup' ? 'Setup Account' : 'Create Soul Id')))}
          </Text>
          <Text style={s.subtitle}>
            {isForgotPassword
              ? (isResetSuccess ? "We've sent a recovery link to your email." : "Enter your email or Soul Id to recover")
              : (isLogin ? 'Soul for Soulmates' 
                : (signupStep === 'otp' ? 'Check your email for the code' 
                  : (signupStep === 'setup' ? 'Set your unique identity' : 'Choose your unique identity')))}
          </Text>

          {/* Error Message */}
          {!!error && (
            <Text style={{ color: '#FF6B6B', fontSize: 13, textAlign: 'center', marginBottom: 12, fontWeight: '600' }}>
              {error}
            </Text>
          )}

          {/* ── MODE: LOGIN ─────────────────────────────────────── */}
          {isLogin && (
            <>
              {/* Email/Soul ID (Used for both Login and Forgot Password) */}
              {!isResetSuccess && (
                <View style={[s.inputWrap, isEmailFocused && s.inputWrapFocused]}>
                  <Feather name={isForgotPassword ? "mail" : "user"} size={20} color={isEmailFocused ? C.accent : '#666'} style={s.inputIcon} />
                  <TextInput
                    style={s.input}
                    placeholder={isForgotPassword ? "Email or Soul Id" : "Soul Id or Email"}
                    placeholderTextColor="#666"
                    value={email}
                    onChangeText={setEmail}
                    onFocus={() => setEmailFocus(true)}
                    onBlur={() => setEmailFocus(false)}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              )}

              {/* Password (Hidden in Forgot Password mode) */}
              {!isForgotPassword && (
                <View style={[s.inputWrap, isPassFocused && s.inputWrapFocused, { marginBottom: 28 }]}>
                  <Feather name="lock" size={20} color={isPassFocused ? C.accent : '#666'} style={s.inputIcon} />
                  <TextInput
                    style={[s.input, { flex: 1 }]}
                    placeholder="Secret Password"
                    placeholderTextColor="#666"
                    value={password}
                    onChangeText={setPassword}
                    onFocus={() => setPassFocus(true)}
                    onBlur={() => setPassFocus(false)}
                    secureTextEntry={!showPassword}
                  />
                  <TouchableOpacity onPress={() => setShowPwd(p => !p)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Feather name={showPassword ? 'eye' : 'eye-off'} size={20} color="#666" />
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}

          {/* ── MODE: SIGNUP ────────────────────────────────────── */}
          {!isLogin && (
            <>
              {/* STEP 1: Email */}
              {signupStep === 'email' && (
                <View style={[s.inputWrap, isRealEmailFocused && s.inputWrapFocused, { marginBottom: 20 }]}>
                  <Feather name="mail" size={20} color={isRealEmailFocused ? C.accent : '#666'} style={s.inputIcon} />
                  <TextInput
                    style={s.input}
                    placeholder="Your Email Address"
                    placeholderTextColor="#666"
                    value={emailSignup}
                    onChangeText={setEmailSignup}
                    onFocus={() => setRealEmailFocus(true)}
                    onBlur={() => setRealEmailFocus(false)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                  />
                </View>
              )}

              {/* STEP 2: OTP */}
              {signupStep === 'otp' && (
                <View style={[s.inputWrap, isOtpFocused && s.inputWrapFocused, { marginBottom: 20 }]}>
                  <Feather name="shield" size={20} color={isOtpFocused ? C.accent : '#666'} style={s.inputIcon} />
                  <TextInput
                    style={[s.input, { letterSpacing: 8, fontSize: 18, fontWeight: '700' }]}
                    placeholder="◯ ◯ ◯ ◯ ◯ ◯"
                    placeholderTextColor="#444"
                    value={otp}
                    onChangeText={(v) => setOtp(v.replace(/[^0-9]/g, ''))}
                    onFocus={() => setOtpFocus(true)}
                    onBlur={() => setOtpFocus(false)}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                  <TouchableOpacity onPress={() => { setOtp(''); setSignupStep('email'); }} hitSlop={15}>
                    <Text style={{ color: C.accent, fontSize: 12, fontWeight: '700' }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* STEP 3: Setup Profile */}
              {signupStep === 'setup' && (
                <>
                  {/* Username Container */}
                  <View style={s.fieldGroup}>
                    <View style={[s.inputWrap, isUsernameFocused && s.inputWrapFocused, 
                      usernameState === 'available' && { borderColor: '#4CAF50' },
                      (usernameState === 'taken' || usernameState === 'invalid') && { borderColor: '#FF4444' }
                    ]}>
                      <Feather name="at-sign" size={20} color={isUsernameFocused ? C.accent : '#666'} style={s.inputIcon} />
                      <TextInput
                        style={s.input}
                        placeholder="Choose Username"
                        placeholderTextColor="#666"
                        value={username}
                        onChangeText={setUsername}
                        onFocus={() => setUserFocus(true)}
                        onBlur={() => setUserFocus(false)}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      {usernameState === 'checking' && <ActivityIndicator size="small" color={C.accent} style={{ marginRight: 8 }} />}
                      {usernameState === 'available' && <MaterialIcons name="check-circle" size={20} color="#4CAF50" style={{ marginRight: 8 }} />}
                      {(usernameState === 'taken' || usernameState === 'invalid') && <MaterialIcons name="cancel" size={20} color="#FF4444" style={{ marginRight: 8 }} />}
                    </View>
                    {!!usernameMessage && (
                      <Text style={{ fontSize: 11, color: usernameState === 'available' ? '#4CAF50' : '#FF6B6B', marginTop: -10, marginBottom: 10, marginLeft: 16 }}>
                        {usernameMessage}
                      </Text>
                    )}
                  </View>

                  {/* Password */}
                  <View style={[s.inputWrap, isPassFocused && s.inputWrapFocused]}>
                    <Feather name="lock" size={20} color={isPassFocused ? C.accent : '#666'} style={s.inputIcon} />
                    <TextInput
                      style={[s.input, { flex: 1 }]}
                      placeholder="Create Password"
                      placeholderTextColor="#666"
                      value={password}
                      onChangeText={setPassword}
                      onFocus={() => setPassFocus(true)}
                      onBlur={() => setPassFocus(false)}
                      secureTextEntry={!showPassword}
                    />
                    <TouchableOpacity onPress={() => setShowPwd(p => !p)} hitSlop={10}>
                      <Feather name={showPassword ? 'eye' : 'eye-off'} size={20} color="#666" />
                    </TouchableOpacity>
                  </View>

                  {/* Confirm Password */}
                  <View style={[s.inputWrap, isConfirmFocused && s.inputWrapFocused, { marginBottom: 28 }]}>
                    <Feather name="shield" size={20} color={isConfirmFocused ? C.accent : '#666'} style={s.inputIcon} />
                    <TextInput
                      style={[s.input, { flex: 1 }]}
                      placeholder="Confirm Password"
                      placeholderTextColor="#666"
                      value={confirmPassword}
                      onChangeText={setConfirm}
                      onFocus={() => setConfFocus(true)}
                      onBlur={() => setConfFocus(false)}
                      secureTextEntry={!showConfirm}
                    />
                    <TouchableOpacity onPress={() => setShowConfirm(p => !p)} hitSlop={10}>
                      <Feather name={showConfirm ? 'eye' : 'eye-off'} size={20} color="#666" />
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </>
          )}

          {/* ── Action Button ─────────────────────────────────────── */}
          <TouchableOpacity 
            style={s.btn} 
            onPress={isResetSuccess ? toggleForgotPassword : handleSubmit} 
            activeOpacity={0.82} 
            disabled={status === 'loading'}
          >
            {status === 'loading' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={s.btnText}>
                {isResetSuccess
                  ? 'Back to Login'
                  : (status === 'success' 
                    ? (isLogin ? 'Hearts Synced ♥' : 'Soul Created ✨') 
                    : (isForgotPassword ? 'Send Recovery Link'
                      : (isLogin ? 'Login' 
                        : (signupStep === 'email' ? 'Send Code' : (signupStep === 'otp' ? 'Verify Code' : 'Finalize Account')))))}
              </Text>
            )}
          </TouchableOpacity>

          {/* Divider & Google (Only in normal login or signup-step-email) */}
          {((isLogin && !isForgotPassword) || (!isLogin && signupStep === 'email')) && (
            <>
              <View style={s.divider}>
                <View style={s.dividerLine} />
                <Text style={s.dividerText}>or</Text>
                <View style={s.dividerLine} />
              </View>

              <TouchableOpacity 
                style={s.googleBtn} 
                onPress={handleGoogleSignIn} 
                activeOpacity={0.82} 
                disabled={status === 'loading'}
              >
                <Text style={s.googleIcon}>G</Text>
                <Text style={s.googleText}>Continue with Google</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Footer Toggle */}
          <View style={[s.footer, !isLogin && { justifyContent: 'center' }]}>
            {isLogin ? (
              isForgotPassword ? (
                <View style={{ alignItems: 'center', width: '100%' }}>
                  {!isResetSuccess && (
                     <TouchableOpacity onPress={toggleForgotPassword}>
                        <Text style={s.footerAccent}>← Back to Login</Text>
                      </TouchableOpacity>
                  )}
                </View>
              ) : (
                <>
                  <TouchableOpacity onPress={toggleForgotPassword}>
                    <Text style={s.footerMuted}>Forget Password?</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={toggleMode}>
                    <Text style={s.footerAccent}>Create Soul Id</Text>
                  </TouchableOpacity>
                </>
              )
            ) : (
              signupStep === 'email' && (
                <TouchableOpacity onPress={toggleMode}>
                  <Text style={s.footerAccent}>← Back to Login</Text>
                </TouchableOpacity>
              )
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  kav: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  bearsWrap: {
    width: 400,
    height: 170,
    alignItems: 'center',
    marginBottom: -50,
    zIndex: 0,
  },
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
  cardGlow: {
    position: 'absolute',
    top: -50,
    alignSelf: 'center',
    width: '100%',
    height: 120,
    backgroundColor: C.accent,
    opacity: 0.2,
    borderRadius: 60,
  },
  title: {
    fontSize: 38,
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
  fieldGroup: {
    marginBottom: 0,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.input,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.inputBorder,
    paddingHorizontal: 16,
    height: 56,
    marginBottom: 14,
  },
  inputWrapFocused: {
    borderColor: C.inputFocus,
    backgroundColor: '#2A2A2C',
  },
  iconText: { fontSize: 15, marginRight: 10, opacity: 0.45 },
  iconFocused: { opacity: 1 },
  inputIcon: { marginRight: 12 },
  input: {
    flex: 1,
    color: C.text,
    fontSize: 15,
    fontWeight: '500',
    paddingVertical: 0,
  },
  eyeIcon: { fontSize: 16, marginLeft: 6 },
  btn: {
    backgroundColor: C.accent,
    borderRadius: 16,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 10,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 18,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.08)' },
  dividerText: { color: C.textMuted, fontSize: 13, paddingHorizontal: 12 },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16,
    height: 56,
    gap: 10,
  },
  googleIcon: { fontSize: 18, fontWeight: '800', color: '#4285F4' },
  googleText: { color: C.text, fontSize: 15, fontWeight: '500' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 22,
  },
  footerMuted: { color: C.textMuted, fontSize: 13, fontWeight: '700' },
  footerAccent: { color: C.accent, fontSize: 13, fontWeight: '700' },
});
