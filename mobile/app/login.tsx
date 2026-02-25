import React, { useState, useRef, useEffect } from 'react';
import {
    View, Text, TextInput, Pressable, StyleSheet, StatusBar,
    Animated, Dimensions, KeyboardAvoidingView, Platform
} from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { SoulSyncLogo } from '../components/SoulSyncLogo';

const { width, height } = Dimensions.get('window');

export default function LoginScreen() {
    const router = useRouter();
    const { login, currentUser } = useApp();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    // Animations
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(50)).current;
    const pulseAnim = useRef(new Animated.Value(1)).current;
    const shakeAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // If already logged in, redirect
        if (currentUser) {
            router.replace('/(tabs)');
            return;
        }

        // Entry animations
        Animated.parallel([
            Animated.timing(fadeAnim, {
                toValue: 1,
                duration: 800,
                useNativeDriver: true,
            }),
            Animated.spring(slideAnim, {
                toValue: 0,
                tension: 50,
                friction: 8,
                useNativeDriver: true,
            }),
        ]).start();

        // Pulse animation for logo
        Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1.05,
                    duration: 2000,
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: 2000,
                    useNativeDriver: true,
                }),
            ])
        ).start();
    }, [currentUser]);

    const shake = () => {
        Animated.sequence([
            Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnim, { toValue: -10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnim, { toValue: 10, duration: 50, useNativeDriver: true }),
            Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
        ]).start();
    };

    const handleLogin = async () => {
        if (!username.trim() || !password.trim()) {
            setError('Please enter username and password');
            shake();
            return;
        }

        const success = await login(username.trim(), password.trim());
        if (success) {
            router.replace('/(tabs)');
        } else {
            setError('Invalid credentials');
            shake();
        }
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.content}
            >
                <Animated.View
                    style={[
                        styles.formContainer,
                        {
                            opacity: fadeAnim,
                            transform: [
                                { translateY: slideAnim },
                                { translateX: shakeAnim }
                            ]
                        }
                    ]}
                >
                    {/* Logo */}
                    <View style={styles.logoContainer}>
                        <SoulSyncLogo width={180} height={180} />
                    </View>

                    {/* Login Form */}
                    <BlurView intensity={40} tint="dark" style={styles.formCard}>
                        <View style={styles.inputContainer}>
                            <MaterialIcons name="person" size={20} color="rgba(255,255,255,0.4)" />
                            <TextInput
                                style={styles.input}
                                placeholder="Username"
                                placeholderTextColor="rgba(255,255,255,0.3)"
                                value={username}
                                onChangeText={(t) => { setUsername(t); setError(''); }}
                                autoCapitalize="none"
                                autoCorrect={false}
                            />
                        </View>

                        <View style={styles.inputContainer}>
                            <MaterialIcons name="lock" size={20} color="rgba(255,255,255,0.4)" />
                            <TextInput
                                style={styles.input}
                                placeholder="Password"
                                placeholderTextColor="rgba(255,255,255,0.3)"
                                value={password}
                                onChangeText={(t) => { setPassword(t); setError(''); }}
                                secureTextEntry={!showPassword}
                                autoCapitalize="none"
                            />
                            <Pressable onPress={() => setShowPassword(!showPassword)}>
                                <MaterialIcons
                                    name={showPassword ? 'visibility' : 'visibility-off'}
                                    size={20}
                                    color="rgba(255,255,255,0.4)"
                                />
                            </Pressable>
                        </View>

                        {error ? (
                            <Text style={styles.errorText}>{error}</Text>
                        ) : null}

                        <Pressable
                            style={({ pressed }) => [
                                styles.loginButton,
                                pressed && styles.loginButtonPressed
                            ]}
                            onPress={handleLogin}
                        >
                            <Text style={styles.loginButtonText}>SYNC CONNECTION</Text>
                            <MaterialIcons name="arrow-forward" size={20} color="#000" />
                        </Pressable>
                    </BlurView>

                    {/* Hint */}
                    <View style={styles.hintContainer}>
                        <Text style={styles.hintText}>Authorized access only</Text>
                        <Text style={styles.hintSubtext}>Shri • Hari</Text>
                    </View>
                </Animated.View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#09090b',
    },
    bgGlow: {
        position: 'absolute',
        top: height * 0.1,
        left: width * 0.5 - 150,
        width: 300,
        height: 300,
        borderRadius: 150,
        backgroundColor: 'rgba(244, 63, 94, 0.15)',
        opacity: 0.6,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    formContainer: {
        alignItems: 'center',
    },
    logoContainer: {
        alignItems: 'center',
        marginBottom: 48,
    },
    logoCircle: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: 'rgba(244, 63, 94, 0.15)',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: 'rgba(244, 63, 94, 0.3)',
        marginBottom: 24,
    },
    logoEmoji: {
        fontSize: 48,
    },
    appName: {
        color: '#ffffff',
        fontSize: 32,
        fontWeight: '900',
        letterSpacing: 8,
    },
    tagline: {
        color: '#f43f5e',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 4,
        marginTop: 8,
    },
    formCard: {
        width: '100%',
        borderRadius: 32,
        padding: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        overflow: 'hidden',
    },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 16,
        paddingHorizontal: 16,
        paddingVertical: 14,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        gap: 12,
    },
    input: {
        flex: 1,
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '500',
    },
    errorText: {
        color: '#ef4444',
        fontSize: 12,
        fontWeight: '600',
        textAlign: 'center',
        marginBottom: 16,
    },
    loginButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#ffffff',
        borderRadius: 16,
        paddingVertical: 16,
        gap: 8,
    },
    loginButtonPressed: {
        transform: [{ scale: 0.98 }],
        opacity: 0.9,
    },
    loginButtonText: {
        color: '#000000',
        fontSize: 14,
        fontWeight: '800',
        letterSpacing: 2,
    },
    hintContainer: {
        marginTop: 32,
        alignItems: 'center',
    },
    hintText: {
        color: 'rgba(255,255,255,0.3)',
        fontSize: 11,
        fontWeight: '500',
        letterSpacing: 1,
    },
    hintSubtext: {
        color: 'rgba(244, 63, 94, 0.5)',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 2,
        marginTop: 4,
    },
});
