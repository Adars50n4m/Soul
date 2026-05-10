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
  Dimensions,
  LayoutAnimation,
} from 'react-native';
import { SoulLoader } from '../components/ui/SoulLoader';
import Svg, { Circle, Path, Ellipse, G } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { authService } from '../services/AuthService';
import { GlassView } from '../components/ui/GlassView';
import { useApp } from '../context/AppContext';

const { width: SCREEN_W } = Dimensions.get('window');
const STROKE = '#3A2B24';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const { activeTheme } = useApp();
  const themeAccent = activeTheme.primary;

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [showPassword, setShowPwd] = useState(false);
  const [isPassFocused, setPassFocus] = useState(false);
  const [isConfirmFocused, setConfFocus] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'fail'>('idle');
  const [error, setError] = useState('');

  // Animated values for bears
  const jumpY = useRef(new Animated.Value(0)).current;
  const shakeX = useRef(new Animated.Value(0)).current;
  const floatY = useRef(new Animated.Value(0)).current;
  const boyBreathe = useRef(new Animated.Value(0)).current;
  const girlBreathe = useRef(new Animated.Value(0)).current;

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
        Animated.timing(floatY, { toValue: 0, duration: 2200, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  const handleSubmit = async () => {
    if (status === 'loading') return;
    setError('');

    if (!password.trim() || password.length < 8) {
      setError('Password must be at least 8 characters.');
      setStatus('fail');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      setStatus('fail');
      return;
    }

    setStatus('loading');
    const res = await authService.updatePassword(password);
    if (res.success) {
      setStatus('success');
      Animated.sequence([
        Animated.timing(jumpY, { toValue: -18, duration: 220, useNativeDriver: true }),
        Animated.spring(jumpY, { toValue: 0, useNativeDriver: true, tension: 180, friction: 7 }),
      ]).start();
      setTimeout(() => router.replace('/login'), 2000);
    } else {
      setError(res.error || 'Failed to update password');
      setStatus('fail');
      Animated.sequence([
        Animated.timing(shakeX, { toValue: -9, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 9, duration: 80, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 0, duration: 80, useNativeDriver: true }),
      ]).start();
    }
  };

  const isAnyFocused = isPassFocused || isConfirmFocused;
  const covering = (isPassFocused || isConfirmFocused) && !showPassword;
  const peeking = (isPassFocused || isConfirmFocused) && showPassword;

  const headPath = (cx: number, cy: number) => `M ${cx} ${cy-50} C ${cx+45} ${cy-50},${cx+72} ${cy-20},${cx+72} ${cy+15} C ${cx+72} ${cy+55},${cx+40} ${cy+65},${cx} ${cy+65} C ${cx-40} ${cy+65},${cx-72} ${cy+55},${cx-72} ${cy+15} C ${cx-72} ${cy-20},${cx-45} ${cy-50},${cx} ${cy-50} Z`;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
        style={[s.kav, { backgroundColor: activeTheme.background }]}
      >
        <Animated.View style={[s.bearsWrap, { transform: [{ translateY: Animated.add(jumpY, floatY) }, { translateX: shakeX }] }]}>
          <Svg width="400" height="240" viewBox="0 0 400 300">
            {[
              { id: 'boy', cx: 145, cy: 90, color: '#FFFFFF', snout: '#FFF0F5', cheek: '#FFCAD6', peekArm: 'right' },
              { id: 'girl', cx: 255, cy: 90, color: '#D69E71', snout: '#F0C4A5', cheek: '#F08B8B', peekArm: 'left' },
            ].map(({ id, cx, cy, color, snout, cheek, peekArm }) => {
              const lAngle = (covering || (peeking && peekArm !== 'left')) ? -170 : 15;
              const rAngle = (covering || (peeking && peekArm !== 'right')) ? 170 : -15;
              const leftArmPath = covering || (peeking && peekArm !== 'left')
                ? `M 14 0 C 22 30,20 65,10 80 A 15 15 0 0 1 -24 70 C -22 35,-20 20,-16 0`
                : `M 12 0 C 18 15,16 35,8 45 A 12 12 0 0 1 -18 38 C -16 20,-14 10,-10 0`;
              const rightArmPath = covering || (peeking && peekArm !== 'right')
                ? `M -14 0 C -22 30,-20 65,-10 80 A 15 15 0 0 0 24 70 C 22 35,20 20,16 0`
                : `M -12 0 C -18 15,-16 35,-8 45 A 12 12 0 0 0 18 38 C 16 20,14 10,10 0`;

              return (
                <G key={id}>
                  <Ellipse cx={cx-24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
                  <Ellipse cx={cx+24} cy={cy+132} rx="12" ry="8" fill={color} stroke={STROKE} strokeWidth="5" />
                  <Path d={`M ${cx-34} ${cy+25} C ${cx-65} ${cy+60},${cx-60} ${cy+135},${cx} ${cy+135} C ${cx+60} ${cy+135},${cx+65} ${cy+60},${cx+34} ${cy+25} Z`} fill={color} stroke={STROKE} strokeWidth="5" />
                  <G>
                    <Circle cx={cx-48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
                    <Circle cx={cx+48} cy={cy-38} r="18" fill={color} stroke={STROKE} strokeWidth="5" />
                    <Path d={headPath(cx, cy)} fill={color} stroke={STROKE} strokeWidth="5" />
                    <Ellipse cx={cx} cy={cy+19} rx="22" ry="16" fill={snout} />
                    <Ellipse cx={cx-42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
                    <Ellipse cx={cx+42} cy={cy+16} rx="12" ry="9" fill={cheek} opacity="0.55" />
                    <Circle cx={cx-24} cy={cy+5} r="6.5" fill={STROKE} />
                    <Circle cx={cx+24} cy={cy+5} r="6.5" fill={STROKE} />
                    <Path d={`M ${cx-2} ${cy+11} Q ${cx} ${cy+13} ${cx+2} ${cy+11} Z`} fill={STROKE} stroke={STROKE} strokeWidth="2" />
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
          <Text style={[s.title, { color: themeAccent }]}>New Secret</Text>
          <Text style={s.subtitle}>Set a strong password to secure your Soul</Text>

          {!!error && <Text style={s.err}>{error}</Text>}

          <View style={[s.inputWrap, isPassFocused && { borderColor: themeAccent }]}>
            <Feather name="lock" size={20} color={isPassFocused ? themeAccent : '#666'} style={s.inputIcon} />
            <TextInput 
              style={s.input} 
              placeholder="New Password" 
              placeholderTextColor="#666" 
              value={password} 
              onChangeText={setPassword} 
              onFocus={() => setPassFocus(true)} 
              onBlur={() => setPassFocus(false)} 
              secureTextEntry={!showPassword} 
            />
            <TouchableOpacity onPress={() => setShowPwd(p => !p)}>
              <Feather name={showPassword ? 'eye' : 'eye-off'} size={20} color={isPassFocused ? themeAccent : "#666"} />
            </TouchableOpacity>
          </View>

          <View style={[s.inputWrap, isConfirmFocused && { borderColor: themeAccent }, { marginBottom: 28 }]}>
            <Feather name="shield" size={20} color={isConfirmFocused ? themeAccent : '#666'} style={s.inputIcon} />
            <TextInput 
              style={s.input} 
              placeholder="Confirm Password" 
              placeholderTextColor="#666" 
              value={confirmPassword} 
              onChangeText={setConfirm} 
              onFocus={() => setConfFocus(true)} 
              onBlur={() => setConfFocus(false)} 
              secureTextEntry={!showPassword} 
            />
          </View>

          <TouchableOpacity 
            style={[s.btn, { backgroundColor: themeAccent }]} 
            onPress={handleSubmit} 
            disabled={status === 'loading' || status === 'success'}
          >
            {status === 'loading' ? <SoulLoader size={36} /> : <Text style={s.btnText}>{status === 'success' ? 'Updated!' : 'Reset Password'}</Text>}
          </TouchableOpacity>

          <TouchableOpacity style={s.backToLogin} onPress={() => router.replace('/login')}>
            <Text style={s.backToLoginText}>Back to Login</Text>
          </TouchableOpacity>
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
  title: { fontSize: 32, fontWeight: '900', textAlign: 'center', color: '#FFFFFF' },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center', marginBottom: 26 },
  err: { color: '#FF6B6B', textAlign: 'center', marginBottom: 12 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#222', borderRadius: 16, borderWidth: 1, borderColor: '#333', paddingHorizontal: 16, height: 56, marginBottom: 14 },
  inputIcon: { marginRight: 12 },
  input: { flex: 1, color: '#fff', fontSize: 15 },
  btn: { borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  backToLogin: { marginTop: 20, alignItems: 'center' },
  backToLoginText: { color: 'rgba(255,255,255,0.5)', fontSize: 14, fontWeight: '600' },
});
