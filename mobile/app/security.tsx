import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Switch, Alert, ScrollView, Platform, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import * as LocalAuthentication from 'expo-local-authentication';

export default function SecurityScreen() {
    const router = useRouter();
    const { 
        activeTheme, 
        biometricEnabled, 
        setBiometricEnabled, 
        pinEnabled, 
        setPinEnabled,
        pin,
        setPin
    } = useApp();

    const [tempPin, setTempPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [isSettingPin, setIsSettingPin] = useState(false);

    const toggleBiometrics = async (val: boolean) => {
        if (val) {
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            if (!hasHardware) {
                Alert.alert('Not Supported', 'Biometric authentication is not supported on this device.');
                return;
            }
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();
            if (!isEnrolled) {
                Alert.alert('Not Enrolled', 'No biometrics found. Please set up Fingerprint/FaceID in your device settings.');
                return;
            }
            
            const result = await LocalAuthentication.authenticateAsync({
                promptMessage: 'Confirm identity to enable biometric lock',
            });
            
            if (result.success) {
                setBiometricEnabled(true);
            }
        } else {
            setBiometricEnabled(false);
        }
    };

    const handlePinSetup = () => {
        if (tempPin.length !== 6) {
            Alert.alert('Invalid PIN', 'PIN must be exactly 6 digits.');
            return;
        }
        if (tempPin !== confirmPin) {
            Alert.alert('PIN Mismatch', 'The PINs you entered do not match.');
            return;
        }
        setPin(tempPin);
        setPinEnabled(true);
        setIsSettingPin(false);
        setTempPin('');
        setConfirmPin('');
        Alert.alert('Success', 'Two-step verification enabled.');
    };

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="arrow-back-ios" size={24} color="#fff" />
                </Pressable>
                <Text style={styles.headerTitle}>Security</Text>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>LOCK SETTINGS</Text>
                    <View style={styles.settingsGroup}>
                        <View style={styles.settingItem}>
                            <View style={[styles.settingIcon, { backgroundColor: `${activeTheme.primary}20` }]}>
                                <Ionicons name="finger-print" size={22} color={activeTheme.primary} />
                            </View>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingTitle}>Fingerprint / Biometric</Text>
                                <Text style={styles.settingSubtitle}>Unlock SoulSync with biometrics</Text>
                            </View>
                            <Switch
                                value={biometricEnabled}
                                onValueChange={toggleBiometrics}
                                trackColor={{ false: '#333', true: activeTheme.primary }}
                                thumbColor="#fff"
                            />
                        </View>
                        
                        <View style={styles.settingItem}>
                            <View style={[styles.settingIcon, { backgroundColor: `${activeTheme.primary}20` }]}>
                                <MaterialIcons name="pin" size={22} color={activeTheme.primary} />
                            </View>
                            <View style={styles.settingInfo}>
                                <Text style={styles.settingTitle}>Two-step Verification</Text>
                                <Text style={styles.settingSubtitle}>Require a PIN to unlock the app</Text>
                            </View>
                            <Switch
                                value={pinEnabled}
                                onValueChange={(val) => {
                                    if (val) setIsSettingPin(true);
                                    else {
                                        Alert.alert(
                                            'Disable PIN?',
                                            'Are you sure you want to disable 2FA?',
                                            [
                                                { text: 'Cancel', style: 'cancel' },
                                                { text: 'Disable', style: 'destructive', onPress: () => {
                                                    setPinEnabled(false);
                                                    setPin(null);
                                                }}
                                            ]
                                        );
                                    }
                                }}
                                trackColor={{ false: '#333', true: activeTheme.primary }}
                                thumbColor="#fff"
                            />
                        </View>
                    </View>
                </View>

                {pinEnabled && (
                    <Pressable style={styles.changePinButton} onPress={() => setIsSettingPin(true)}>
                        <Text style={[styles.changePinText, { color: activeTheme.primary }]}>Change PIN</Text>
                    </Pressable>
                )}

                <View style={styles.infoBox}>
                    <MaterialIcons name="info-outline" size={20} color="rgba(255,255,255,0.4)" />
                    <Text style={styles.infoText}>
                        When enabled, SoulSync will ask for authentication every time you open the app or return to it.
                    </Text>
                </View>
            </ScrollView>

            {isSettingPin && (
                <View style={styles.modalOverlay}>
                    <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Set 6-Digit PIN</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter 6-digit PIN"
                            placeholderTextColor="rgba(255,255,255,0.3)"
                            keyboardType="numeric"
                            maxLength={6}
                            secureTextEntry
                            value={tempPin}
                            onChangeText={setTempPin}
                        />
                        <TextInput
                            style={styles.input}
                            placeholder="Confirm PIN"
                            placeholderTextColor="rgba(255,255,255,0.3)"
                            keyboardType="numeric"
                            maxLength={6}
                            secureTextEntry
                            value={confirmPin}
                            onChangeText={setConfirmPin}
                        />
                        <View style={styles.modalButtons}>
                            <Pressable style={styles.modalButton} onPress={() => setIsSettingPin(false)}>
                                <Text style={styles.buttonTextCancel}>Cancel</Text>
                            </Pressable>
                            <Pressable 
                                style={[styles.modalButton, styles.primaryButton, { backgroundColor: activeTheme.primary }]} 
                                onPress={handlePinSetup}
                            >
                                <Text style={styles.buttonText}>Save</Text>
                            </Pressable>
                        </View>
                    </View>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: 60,
        paddingHorizontal: 16,
        paddingBottom: 20,
    },
    backButton: {
        padding: 8,
    },
    headerTitle: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '700',
        marginLeft: 8,
    },
    scrollContent: {
        paddingHorizontal: 16,
    },
    section: {
        marginTop: 24,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        fontWeight: '900',
        letterSpacing: 2,
        marginBottom: 12,
        paddingHorizontal: 8,
    },
    settingsGroup: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 16,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.05)',
    },
    settingIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 16,
    },
    settingInfo: {
        flex: 1,
    },
    settingTitle: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
    settingSubtitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 13,
        marginTop: 2,
    },
    changePinButton: {
        padding: 16,
        alignItems: 'center',
    },
    changePinText: {
        fontSize: 15,
        fontWeight: '600',
    },
    infoBox: {
        flexDirection: 'row',
        backgroundColor: 'rgba(255,255,255,0.03)',
        padding: 16,
        borderRadius: 12,
        marginTop: 24,
        gap: 12,
    },
    infoText: {
        flex: 1,
        color: 'rgba(255,255,255,0.4)',
        fontSize: 13,
        lineHeight: 18,
    },
    modalOverlay: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
    },
    modalContent: {
        width: '85%',
        backgroundColor: '#1a1a1a',
        borderRadius: 24,
        padding: 24,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    modalTitle: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '700',
        marginBottom: 24,
        textAlign: 'center',
    },
    input: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 12,
        padding: 16,
        color: '#fff',
        fontSize: 18,
        textAlign: 'center',
        marginBottom: 16,
        letterSpacing: 4,
    },
    modalButtons: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
    },
    modalButton: {
        flex: 1,
        height: 50,
        borderRadius: 25,
        justifyContent: 'center',
        alignItems: 'center',
    },
    primaryButton: {
        backgroundColor: '#fff',
    },
    buttonText: {
        color: '#fff',
        fontWeight: '700',
        fontSize: 16,
    },
    buttonTextCancel: {
        color: 'rgba(255,255,255,0.5)',
        fontWeight: '600',
        fontSize: 16,
    },
});
