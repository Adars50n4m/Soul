import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, Alert, Platform } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { useApp } from '../context/AppContext';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';

export const SecurityLockOverlay = () => {
    const { isLocked, unlockApp, biometricEnabled, pinEnabled, pin, activeTheme } = useApp();
    const [enteredPin, setEnteredPin] = useState('');
    const [isBiometricSupported, setIsBiometricSupported] = useState(false);

    useEffect(() => {
        if (isLocked) {
            checkBiometrics();
        }
    }, [isLocked]);

    const checkBiometrics = async () => {
        if (!biometricEnabled) return;

        const compatible = await LocalAuthentication.hasHardwareAsync();
        setIsBiometricSupported(compatible);

        if (compatible) {
            const enrolled = await LocalAuthentication.isEnrolledAsync();
            if (enrolled) {
                const result = await LocalAuthentication.authenticateAsync({
                    promptMessage: 'Unlock SoulSync',
                    fallbackLabel: pinEnabled ? 'Use PIN' : undefined,
                });

                if (result.success) {
                    unlockApp();
                }
            }
        }
    };

    const handleNumberPress = (num: string) => {
        if (enteredPin.length < 6) {
            const newPin = enteredPin + num;
            setEnteredPin(newPin);
            if (newPin === pin) {
                unlockApp();
                setEnteredPin('');
            } else if (newPin.length === 6) {
                Alert.alert('Incorrect PIN', 'Please try again.');
                setEnteredPin('');
            }
        }
    };

    const handleDelete = () => {
        setEnteredPin(prev => prev.slice(0, -1));
    };

    if (!isLocked) return null;

    return (
        <Modal visible={isLocked} animationType="fade" transparent>
            <BlurView intensity={100} tint="dark" style={styles.container} experimentalBlurMethod="dimezisBlurView">
                <View style={styles.content}>
                    <View style={[styles.iconContainer, { backgroundColor: `${activeTheme.primary}20` }]}>
                        <MaterialIcons name="lock" size={48} color={activeTheme.primary} />
                    </View>
                    <Text style={styles.title}>SoulSync Locked</Text>
                    <Text style={styles.subtitle}>
                        {pinEnabled ? 'Enter your 6-digit PIN' : 'Authenticate to unlock'}
                    </Text>

                    {pinEnabled && (
                        <View style={styles.pinDisplay}>
                            {[0, 1, 2, 3, 4, 5].map((i) => (
                                <View 
                                    key={i} 
                                    style={[
                                        styles.pinDot, 
                                        enteredPin.length > i && { backgroundColor: activeTheme.primary }
                                    ]} 
                                />
                            ))}
                        </View>
                    )}

                    {pinEnabled && (
                        <View style={styles.numpad}>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                                <Pressable 
                                    key={num} 
                                    style={styles.numButton} 
                                    onPress={() => handleNumberPress(num.toString())}
                                >
                                    <Text style={styles.numText}>{num}</Text>
                                </Pressable>
                            ))}
                            <Pressable style={styles.numButton} onPress={checkBiometrics}>
                                {biometricEnabled && <Ionicons name="finger-print" size={28} color="#fff" />}
                            </Pressable>
                            <Pressable style={styles.numButton} onPress={() => handleNumberPress('0')}>
                                <Text style={styles.numText}>0</Text>
                            </Pressable>
                            <Pressable style={styles.numButton} onPress={handleDelete}>
                                <MaterialIcons name="backspace" size={24} color="#fff" />
                            </Pressable>
                        </View>
                    )}

                    {!pinEnabled && biometricEnabled && (
                        <Pressable style={styles.unlockButton} onPress={checkBiometrics}>
                            <Text style={[styles.unlockButtonText, { color: activeTheme.primary }]}>Tap to Unlock</Text>
                        </Pressable>
                    )}
                </View>
            </BlurView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    content: {
        alignItems: 'center',
        width: '100%',
        paddingHorizontal: 40,
    },
    iconContainer: {
        width: 100,
        height: 100,
        borderRadius: 50,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: 24,
    },
    title: {
        color: '#fff',
        fontSize: 24,
        fontWeight: '700',
        marginBottom: 8,
    },
    subtitle: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
        marginBottom: 40,
    },
    pinDisplay: {
        flexDirection: 'row',
        gap: 15,
        marginBottom: 60,
    },
    pinDot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.3)',
    },
    numpad: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        width: '100%',
        gap: 20,
    },
    numButton: {
        width: 70,
        height: 70,
        borderRadius: 35,
        backgroundColor: 'rgba(255,255,255,0.1)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    numText: {
        color: '#fff',
        fontSize: 28,
        fontWeight: '600',
    },
    unlockButton: {
        paddingVertical: 12,
        paddingHorizontal: 32,
        borderRadius: 24,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    unlockButtonText: {
        fontSize: 16,
        fontWeight: '700',
    },
});
