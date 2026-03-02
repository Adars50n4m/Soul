import React from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { useApp, PrivacyValue } from '../context/AppContext';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

const PrivacyOption = ({ title, selected, onPress }: { title: string; selected: boolean; onPress: () => void }) => (
    <Pressable style={styles.optionItem} onPress={onPress}>
        <Text style={[styles.optionText, selected && styles.optionTextActive]}>{title}</Text>
        {selected && <MaterialIcons name="check" size={20} color="#fff" />}
    </Pressable>
);

const PrivacySection = ({ title, value, options, onSelect }: { 
    title: string; 
    value: PrivacyValue; 
    options: { label: string; value: PrivacyValue }[];
    onSelect: (val: PrivacyValue) => void;
}) => (
    <View style={styles.section}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <View style={styles.optionsGroup}>
            {options.map((opt) => (
                <PrivacyOption 
                    key={opt.value}
                    title={opt.label}
                    selected={value === opt.value}
                    onPress={() => onSelect(opt.value)}
                />
            ))}
        </View>
    </View>
);

export default function PrivacyScreen() {
    const router = useRouter();
    const { privacySettings, updatePrivacy, activeTheme } = useApp();

    const privacyOptions: { label: string; value: PrivacyValue }[] = [
        { label: 'Everyone', value: 'everyone' },
        { label: 'My Contacts', value: 'contacts' },
        { label: 'Nobody', value: 'nobody' }
    ];

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />
            
            {/* Header */}
            <View style={styles.header}>
                <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                <Pressable onPress={() => router.back()} style={styles.backButton}>
                    <MaterialIcons name="arrow-back" size={24} color="#fff" />
                </Pressable>
                <Text style={styles.headerTitle}>Privacy</Text>
                <View style={{ width: 40 }} />
            </View>

            <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
                <Animated.View entering={FadeInDown.duration(400).delay(100)}>
                    <PrivacySection 
                        title="WHO CAN SEE MY LAST SEEN"
                        value={privacySettings.lastSeen}
                        options={privacyOptions}
                        onSelect={(val) => updatePrivacy({ lastSeen: val })}
                    />
                    
                    <PrivacySection 
                        title="WHO CAN SEE MY PROFILE PHOTO"
                        value={privacySettings.profilePhoto}
                        options={privacyOptions}
                        onSelect={(val) => updatePrivacy({ profilePhoto: val })}
                    />

                    <PrivacySection 
                        title="WHO CAN SEE MY STATUS UPDATES"
                        value={privacySettings.status}
                        options={privacyOptions}
                        onSelect={(val) => updatePrivacy({ status: val })}
                    />

                    <View style={styles.section}>
                        <Text style={styles.sectionTitle}>MESSAGING</Text>
                        <View style={styles.optionsGroup}>
                            <Pressable 
                                style={styles.optionItem} 
                                onPress={() => updatePrivacy({ readReceipts: !privacySettings.readReceipts })}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={styles.optionText}>Read Receipts</Text>
                                    <Text style={styles.optionSubtext}>
                                        If turned off, you won't send or receive Read Receipts. Read receipts are always sent for group chats.
                                    </Text>
                                </View>
                                <View style={[styles.toggle, privacySettings.readReceipts && { backgroundColor: activeTheme.primary }]}>
                                    <View style={[styles.toggleKnob, privacySettings.readReceipts && styles.toggleKnobActive]} />
                                </View>
                            </Pressable>
                        </View>
                    </View>

                    <View style={styles.infoBox}>
                         <MaterialIcons name="info-outline" size={20} color="rgba(255,255,255,0.4)" />
                         <Text style={styles.infoText}>
                            Your privacy is our priority. Any changes you make here are synchronized instantly across all your devices.
                         </Text>
                    </View>
                </Animated.View>
            </ScrollView>
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
        justifyContent: 'space-between',
        paddingTop: 60,
        paddingBottom: 20,
        paddingHorizontal: 16,
        zIndex: 100,
    },
    backButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
    },
    headerTitle: {
        color: '#fff',
        fontSize: 18,
        fontWeight: '700',
    },
    content: {
        flex: 1,
    },
    scrollContent: {
        paddingTop: 20,
        paddingBottom: 60,
    },
    section: {
        marginBottom: 32,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 11,
        fontWeight: '900',
        letterSpacing: 2,
        paddingHorizontal: 24,
        marginBottom: 12,
    },
    optionsGroup: {
        marginHorizontal: 16,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
    },
    optionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.05)',
    },
    settingInfo: {
        flex: 1,
    },
    optionText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 16,
        fontWeight: '500',
        flex: 1,
    },
    optionTextActive: {
        color: '#fff',
        fontWeight: '600',
    },
    optionSubtext: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12,
        marginTop: 4,
        paddingRight: 10,
    },
    toggle: {
        width: 48,
        height: 28,
        borderRadius: 14,
        backgroundColor: 'rgba(255,255,255,0.1)',
        padding: 2,
    },
    toggleKnob: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: '#fff',
    },
    toggleKnobActive: {
        marginLeft: 20,
    },
    infoBox: {
        flexDirection: 'row',
        marginHorizontal: 24,
        marginTop: 8,
        padding: 16,
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 16,
        gap: 12,
    },
    infoText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 13,
        lineHeight: 18,
        flex: 1,
    }
});
