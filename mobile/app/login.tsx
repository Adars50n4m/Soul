/**
 * SoulSync — Couple Teddy Bears Login (React Native)
 * ✅ Fixed: "Moved to native" Error & Blink Stability.
 * Consistent use of JS driver for SVG properties to ensure stability.
 * ✅ Updated: OTP-based login + Google Sign-In + Forgot Password
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Animated,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { GlassView } from '../components/ui/GlassView';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Path,
  Circle,
  Ellipse,
  G,
  Defs,
  ClipPath,
  Rect,
} from 'react-native-svg';
import { useRouter } from 'expo-router';
import { useApp } from '../context/AppContext';
import { authService } from '../services/AuthService';

const AnimatedG = Animated.createAnimatedComponent(G) as any;
const AnimatedPath = Animated.createAnimatedComponent(Path) as any;
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse) as any;
const AnimatedRect = Animated.createAnimatedComponent(Rect) as any;
const AnimatedCircle = Animated.createAnimatedComponent(Circle) as any;

const { width } = Dimensions.get('window');

const C = {
  bg:         '#0a0a0a',
  pinkMid:    '#EC4899',
  pinkText:   '#FBCFE8',
  boyMain:    '#9B6A41',
  boyLight:   '#E8BE9A',
  boyPaw:     '#845630',
  girlMain:   '#D88D6D',
  girlLight:  '#FAD6C3',
  girlPaw:    '#B87355',
  bearDark:   '#26160D',
  blush:      '#FF8DA1',
  bowPink:    '#F472B6',
  bowDark:    '#DB2777',
};

export default function LoginScreen() {
  const router = useRouter();
  const { login, setSession, currentUser } = useApp();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isEmailFocused, setIsEmailFocused] = useState(false);
  const [isPasswordFocused, setIsPasswordFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState('idle');

  // Animated Values
  const breatheAnim = useRef(new Animated.Value(0)).current;
  const blinkAnim   = useRef(new Animated.Value(0)).current;
  const pawsLHAnim  = useRef(new Animated.Value(0)).current; 
  const pawsRHAnim  = useRef(new Animated.Value(0)).current; 
  const statusAnim  = useRef(new Animated.Value(0)).current;

  // ─── Animations ──────────────────────────────

  useEffect(() => {
    if (currentUser) {
      router.replace('/(tabs)');
    }
  }, [currentUser]);

  useEffect(() => {
    let isActive = true;
    let blinkTimer: any = null;
    
    // Breathing loop (JS Driver for SVG stability)
    Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, { toValue: 1, duration: 2000, useNativeDriver: false }),
        Animated.timing(breatheAnim, { toValue: 0, duration: 2000, useNativeDriver: false }),
      ])
    ).start();

    // Blinking loop (Using setTimeout for reliable long delays on Android)
    // Blinking loop (Robust strict single-timer)
    const runBlink = () => {
      if (!isActive) return;
      if (blinkTimer) clearTimeout(blinkTimer);
      
      // Extremely slow: 25 to 50 seconds delay
      const nextDelay = Math.random() * 25000 + 25000;
      
      blinkTimer = setTimeout(() => {
        if (!isActive) return;
        
        Animated.sequence([
          Animated.timing(blinkAnim, { toValue: 1, duration: 200, useNativeDriver: false }),
          Animated.timing(blinkAnim, { toValue: 0, duration: 200, useNativeDriver: false }),
        ]).start(({ finished }) => {
          if (isActive && finished) {
            runBlink();
          }
        });
      }, nextDelay);
    };
    
    runBlink();

    return () => {
      isActive = false;
      if (blinkTimer) clearTimeout(blinkTimer);
      blinkAnim.stopAnimation();
    };
  }, []);

  useEffect(() => {
    const LHMove = isPasswordFocused ? 1 : 0;
    const RHMove = (isPasswordFocused && !showPassword) ? 1 : 0;
    Animated.parallel([
      Animated.spring(pawsLHAnim, { toValue: LHMove, friction: 6, tension: 40, useNativeDriver: false }),
      Animated.spring(pawsRHAnim, { toValue: RHMove, friction: 6, tension: 40, useNativeDriver: false })
    ]).start();
  }, [isPasswordFocused, showPassword]);

  useEffect(() => {
    if (status === 'success' || status === 'fail') {
      Animated.sequence([
        Animated.timing(statusAnim, { toValue: status === 'success' ? 1 : -1, duration: 150, useNativeDriver: false }),
        Animated.timing(statusAnim, { toValue: status === 'success' ? 0 : 1, duration: 150, useNativeDriver: false }),
        Animated.timing(statusAnim, { toValue: 0, duration: 150, useNativeDriver: false }),
      ]).start();
      
      if (status === 'fail') {
        const timer = setTimeout(() => setStatus('idle'), 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [status]);

  const handleLogin = async () => {
    if (status === 'loading') return;
    if (!email.trim() || !password.trim()) {
      setStatus('fail');
      return;
    }
    setStatus('loading');

    // email field accepts email OR username
    const result = await authService.signInWithPassword(email, password);

    if (result.success && result.user) {
      // Sync the user state to AppContext for UI redirection
      await setSession(result.user.id);
      setStatus('success');
      setTimeout(() => router.replace('/(tabs)'), 1500);
    } else {
      setStatus('fail');
    }
  };

  const handleGoogleSignIn = async () => {
    if (status === 'loading') return;
    setStatus('loading');

    const result = await authService.signInWithGoogle();

    if (result.success) {
      setStatus('success');
      if (result.isNewUser) {
        setTimeout(() => router.push('/username-setup'), 1000);
      } else {
        setTimeout(() => router.replace('/(tabs)'), 1000);
      }
    } else {
      setStatus('fail');
    }
  };

  const handleCreateAccount = () => {
    router.push('/signup');
  };

  // ─── Tracking & Paths ───────────────────────
  
  const trackingLength = isEmailFocused ? email.length : (isPasswordFocused && showPassword ? password.length : 0);
  const targetPupilX = (isEmailFocused || (isPasswordFocused && showPassword)) ? (Math.min(trackingLength / 25, 1) * 16 - 8) : 0;

  let pupilY = 2;
  if (status === 'fail') pupilY = 12;
  else if (isEmailFocused) pupilY = 8;
  else if (isPasswordFocused && showPassword) pupilY = 10;

  const getMouthPath = (cx, cy) => {
    if (status === 'success') return `M ${cx - 24} ${cy + 28} Q ${cx} ${cy + 65} ${cx + 24} ${cy + 28} Q ${cx} ${cy + 32} ${cx - 24} ${cy + 28}`;
    if (status === 'fail') return `M ${cx - 14} ${cy + 42} Q ${cx} ${cy + 28} ${cx + 14} ${cy + 42} Q ${cx} ${cy + 34} ${cx - 14} ${cy + 42}`;
    if (isPasswordFocused && !showPassword) return `M ${cx - 12} ${cy + 34} Q ${cx} ${cy + 38} ${cx + 12} ${cy + 34} Q ${cx} ${cy + 32} ${cx - 12} ${cy + 34}`;
    if (isEmailFocused || (isPasswordFocused && showPassword)) {
      const o = 38 + (email.length % 4) * 3;
      return `M ${cx - 16} ${cy + 30} Q ${cx} ${cy + o} ${cx + 16} ${cy + 30} Q ${cx} ${cy + 32} ${cx - 16} ${cy + 30}`;
    }
    return `M ${cx - 18} ${cy + 30} Q ${cx} ${cy + 46} ${cx + 18} ${cy + 30} Q ${cx} ${cy + 36} ${cx - 18} ${cy + 30}`;
  };

  // Interpolations
  const headRotBoy  = breatheAnim.interpolate({ inputRange: [0, 1], outputRange: ['2deg', '4deg'] });
  const headRotGirl = breatheAnim.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '-4deg'] });
  const headY       = breatheAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 3] });
  const bodySX      = breatheAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] });
  const bodySY      = breatheAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.98] });
  
  const pawLHY      = pawsLHAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -90] });
  const pawLHScale  = pawsLHAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const pawRHY      = pawsRHAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -90] });
  const pawRHScale  = pawsRHAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  
  // Eye Blink - Animating RY (radius) directly ensures zero shift
  const eyeRY       = blinkAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0.5] });
  const pupilRY     = blinkAnim.interpolate({ inputRange: [0, 1], outputRange: [9, 0.3] });

  const containerTrans = statusAnim.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: status === 'fail' ? [-8, 0, 8] : [0, 0, -15],
  });

  const bears = [
    { id: 'boy', cx: 135, cy: 110, colorMain: C.boyMain, colorLight: C.boyLight, colorPaw: C.boyPaw, hasBow: false, rot: headRotBoy },
    { id: 'girl', cx: 265, cy: 110, colorMain: C.girlMain, colorLight: C.girlLight, colorPaw: C.girlPaw, hasBow: true, rot: headRotGirl },
  ];

  return (
    <View style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.keyboardView}>
        
        <Animated.View style={[styles.svgContainer, { transform: [status === 'fail' ? { translateX: containerTrans } : { translateY: containerTrans }] }]}>
          <Svg 
            width="360" 
            height="200" 
            viewBox="0 0 400 240" 
            onLayout={() => {}}
            pointerEvents="none"
            collapsable={false}
          >
            <Defs>
              {bears.map(b => (
              <ClipPath id={`mouth-clip-${b.id}`} key={`clip-${b.id}`}>
                <Path d={getMouthPath(b.cx, b.cy)} />
              </ClipPath>
              ))}
            </Defs>

            {bears.map(bear => {
              const { id, cx, cy, colorMain, colorLight, colorPaw, hasBow, rot } = bear;
              return (
                <G key={id}>
                  {/* Body */}
                  <AnimatedG originX={cx} originY={240} style={{ transform: [{ scaleX: bodySX }, { scaleY: bodySY }] }}>
                    <Path d={`M ${cx - 70} 240 C ${cx - 70} 140, ${cx + 70} 140, ${cx + 70} 240 Z`} fill={colorMain} />
                  </AnimatedG>

                  {/* Head */}
                  <AnimatedG originX={cx} originY={cy} style={{ transform: [{ rotate: rot }, { translateY: headY }] }}>
                    <Circle cx={cx-65} cy={cy-45} r="28" fill={colorMain} />
                    <Circle cx={cx-65} cy={cy-45} r="15" fill={colorLight} />
                    <Circle cx={cx+65} cy={cy-45} r="28" fill={colorMain} />
                    <Circle cx={cx+65} cy={cy-45} r="15" fill={colorLight} />
                    <Circle cx={cx} cy={cy} r="75" fill={colorMain} />

                    {hasBow && (
                      <G>
                        <Path d={`M ${cx+40} ${cy-65} L ${cx+25} ${cy-80} L ${cx+25} ${cy-50} Z`} fill={C.bowPink} />
                        <Path d={`M ${cx+40} ${cy-65} L ${cx+55} ${cy-80} L ${cx+55} ${cy-50} Z`} fill={C.bowPink} />
                        <Circle cx={cx+40} cy={cy-65} r="7" fill={C.bowDark} />
                      </G>
                    )}

                    <Ellipse cx={cx - 48} cy={cy + 12} rx="12" ry="6" fill={C.blush} opacity={hasBow ? 0.6 : 0.3} />
                    <Ellipse cx={cx + 48} cy={cy + 12} rx="12" ry="6" fill={C.blush} opacity={hasBow ? 0.6 : 0.3} />

                    {/* Eyes — Animating RY directly (Zero Shift) */}
                    <G>
                      {status === 'success' ? (
                        <G>
                          <Path d={`M ${cx-52} ${cy} Q ${cx-38} ${cy-14} ${cx-24} ${cy}`} stroke={C.bearDark} strokeWidth="4" strokeLinecap="round" fill="none" />
                          <Path d={`M ${cx+24} ${cy} Q ${cx+38} ${cy-14} ${cx+52} ${cy}`} stroke={C.bearDark} strokeWidth="4" strokeLinecap="round" fill="none" />
                        </G>
                      ) : (
                        <G>
                          <AnimatedEllipse cx={cx-38} cy={cy} rx={16} ry={eyeRY} fill="white" />
                          <AnimatedEllipse cx={cx+38} cy={cy} rx={16} ry={eyeRY} fill="white" />
                          <G transform={`translate(${targetPupilX}, ${pupilY})`}>
                            <AnimatedEllipse cx={cx-38} cy={cy} rx={9} ry={pupilRY} fill={C.bearDark} />
                            <AnimatedCircle cx={cx-41} cy={cy-3} r="3" fill="white" opacity={blinkAnim.interpolate({inputRange:[0,0.5], outputRange:[1,0]}) as any} />
                            <AnimatedEllipse cx={cx+38} cy={cy} rx={9} ry={pupilRY} fill={C.bearDark} />
                            <AnimatedCircle cx={cx+35} cy={cy-3} r="3" fill="white" opacity={blinkAnim.interpolate({inputRange:[0,0.5], outputRange:[1,0]}) as any} />
                          </G>
                        </G>
                      )}
                    </G>

                    <Ellipse cx={cx} cy={cy+32} rx="34" ry="24" fill={colorLight} />
                    <Path d={`M ${cx} ${cy+24} C ${cx-8} ${cy+16}, ${cx-4} ${cy+12}, ${cx} ${cy+17} C ${cx+4} ${cy+12}, ${cx+8} ${cy+16}, ${cx} ${cy+24} Z`} fill={C.bearDark} />
                    <G>
                      <Path d={getMouthPath(bear.cx, bear.cy)} fill={C.bearDark} />
                      <Ellipse cx={cx} cy={cy+44} rx="14" ry="10" fill={C.blush} clipPath={`url(#mouth-clip-${id})`} />
                    </G>
                  </AnimatedG>

                  {/* LH (Cover eye 1) */}
                  <AnimatedG originX={cx-60} originY={200} style={{ transform: [{ translateY: pawLHY }, { translateX: isPasswordFocused ? 22 : 0 }] }}>
                    <AnimatedRect x={cx-84} y="200" width="48" height="85" fill={colorPaw} rx="24" style={{ transform: [{ scaleY: pawLHScale }] }} />
                    <Ellipse cx={cx-60} cy="200" rx="24" ry="32" fill={colorPaw} />
                  </AnimatedG>
                  {/* RH (Cover eye 2) */}
                  <AnimatedG originX={cx+60} originY={200} style={{ transform: [{ translateY: pawRHY }, { translateX: (isPasswordFocused && !showPassword) ? -22 : 0 }] }}>
                    <AnimatedRect x={cx+36} y="200" width="48" height="85" fill={colorPaw} rx="24" style={{ transform: [{ scaleY: pawRHScale }] }} />
                    <Ellipse cx={cx+60} cy="200" rx="24" ry="32" fill={colorPaw} />
                  </AnimatedG>
                </G>
              );
            })}
          </Svg>
        </Animated.View>

        <View style={styles.cardContainer}>
          <GlassView 
            intensity={Platform.OS === 'ios' ? 85 : 90} 
            tint="dark" 
            style={StyleSheet.absoluteFill}
          />
          {/* Subtle "Gloss" highlight layer */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.03)' }]} />
          
          <View style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>SoulSync</Text>
              <Text style={styles.subtitle}>Join the cutest couples today ✨</Text>
            </View>

            {/* Email */}
            <View style={styles.inputContainer}>
              <View style={styles.iconWrapper}><Feather name="user" size={20} color={isEmailFocused ? '#EC4899' : '#9CA3AF'} /></View>
              <TextInput style={styles.input} placeholder="Email or Username" placeholderTextColor="#9CA3AF" onFocus={() => setIsEmailFocused(true)} onBlur={() => setIsEmailFocused(false)} onChangeText={setEmail} value={email} autoCapitalize="none" autoCorrect={false} />
            </View>

            {/* Password */}
            <View style={styles.inputContainer}>
              <View style={styles.iconWrapper}><Feather name="lock" size={20} color={isPasswordFocused ? '#EC4899' : '#9CA3AF'} /></View>
              <TextInput style={styles.input} placeholder="Password" placeholderTextColor="#9CA3AF" secureTextEntry={!showPassword} onFocus={() => setIsPasswordFocused(true)} onBlur={() => setIsPasswordFocused(false)} onChangeText={setPassword} value={password} autoCapitalize="none" />
              <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowPassword(!showPassword)}>
                <Feather name={showPassword ? 'eye' : 'eye-off'} size={20} color="#9CA3AF" />
              </TouchableOpacity>
            </View>

            {/* Login Button */}
            <TouchableOpacity activeOpacity={0.8} onPress={handleLogin} disabled={status === 'loading'}>
              <LinearGradient colors={['#EC4899', '#F43F5E']} style={styles.btn}>
                {status === 'loading' ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.btnText}>{status === 'success' ? 'Hearts Synced 💕' : 'Sync Hearts'}</Text>}
              </LinearGradient>
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Google Sign-In */}
            <TouchableOpacity activeOpacity={0.8} onPress={handleGoogleSignIn} disabled={status === 'loading'}>
              <View style={styles.googleBtn}>
                <Text style={styles.googleIcon}>G</Text>
                <Text style={styles.googleBtnText}>Continue with Google</Text>
              </View>
            </TouchableOpacity>

            {/* Footer */}
            <View style={styles.footer}>
              <TouchableOpacity onPress={() => router.push('/forgot-password')}><Text style={styles.footerMuted}>Forgot password?</Text></TouchableOpacity>
              <TouchableOpacity onPress={handleCreateAccount}><Text style={styles.footerPink}>Create Account</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', alignItems: 'center', justifyContent: 'center' },
  keyboardView: { width: '100%', maxWidth: 400, alignItems: 'center', paddingHorizontal: 20 },
  svgContainer: { width: 400, height: 180, marginBottom: -55, zIndex: 0, alignItems: 'center', justifyContent: 'flex-end' },
  cardContainer: { width: '100%', borderRadius: 32, overflow: 'hidden', zIndex: 10 },
  card: { 
    width: '100%', 
    padding: 30, 
    paddingTop: 45, 
    backgroundColor: Platform.OS === 'ios' ? 'rgba(30, 30, 30, 0.4)' : 'rgba(30, 30, 30, 0.85)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 25 },
    shadowOpacity: 0.5,
    shadowRadius: Platform.OS === 'ios' ? 35.5 : 10,
    elevation: Platform.OS === 'ios' ? 0 : 2,
  },
  header: { alignItems: 'center', marginBottom: 25 },
  title: { fontSize: 34, fontWeight: '900', color: '#EC4899', letterSpacing: -0.5 },
  subtitle: { color: '#FBCFE8', opacity: 0.9, marginTop: 6, fontWeight: '600', fontSize: 14 },
  inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 16, marginBottom: 16, height: 56 },
  iconWrapper: { paddingHorizontal: 16, justifyContent: 'center' },
  input: { flex: 1, color: '#FFFFFF', fontSize: 16, fontWeight: '500', height: '100%' },
  eyeBtn: { paddingHorizontal: 16, height: '100%', justifyContent: 'center' },
  btn: { 
    height: 56, 
    borderRadius: 16, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginTop: 10, 
    shadowColor: '#EC4899', 
    shadowOpacity: 0.4, 
    shadowRadius: Platform.OS === 'ios' ? 12 : 5, 
    elevation: Platform.OS === 'ios' ? 10 : 3 
  },
  btnText: { color: '#FFFFFF', fontSize: 18, fontWeight: 'bold' },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.1)' },
  dividerText: { color: '#9CA3AF', fontSize: 13, paddingHorizontal: 12 },
  googleBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 16, height: 56, gap: 10 },
  googleIcon: { fontSize: 18, fontWeight: '800', color: '#4285F4' },
  googleBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '500' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24 },
  footerMuted: { color: '#9CA3AF', fontWeight: '500' },
  footerPink: { color: '#EC4899', fontWeight: 'bold' },
});
