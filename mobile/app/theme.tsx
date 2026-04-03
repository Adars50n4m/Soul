import React from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar, ScrollView } from 'react-native';
import { useNavigation } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useApp, THEMES, ThemeName } from '../context/AppContext';

export default function ThemeScreen() {
    const navigation = useNavigation();
    const { theme, setTheme, activeTheme } = useApp();

    const handleSelectTheme = (themeName: ThemeName) => {
        setTheme(themeName);
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {/* Header */}
            <View style={styles.header}>
                <Pressable 
                    onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                    }} 
                    style={styles.backButton}
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>
                <Text style={styles.headerTitle}>THEME</Text>
                <View style={styles.placeholder} />
            </View>

            <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                <Text style={styles.sectionTitle}>CHOOSE YOUR VIBE</Text>

                <View style={styles.themeGrid}>
                    {(Object.keys(THEMES ?? {}) as ThemeName[]).map((themeName) => {
                        const themeConfig = THEMES[themeName];
                        const isSelected = theme === themeName;

                        return (
                            <Pressable
                                key={themeName}
                                style={[
                                    styles.themeCard,
                                    isSelected && { borderColor: themeConfig.primary }
                                ]}
                                onPress={() => handleSelectTheme(themeName)}
                            >
                                {/* Theme Preview */}
                                <View style={[styles.themePreview, { backgroundColor: themeConfig.background }]}>
                                    {/* Mini App Preview */}
                                    <View style={styles.miniHeader}>
                                        <View style={[styles.miniDot, { backgroundColor: themeConfig.primary }]} />
                                        <View style={styles.miniLine} />
                                    </View>
                                    <View style={styles.miniChatList}>
                                        <View style={styles.miniChatItem}>
                                            <View style={styles.miniAvatar} />
                                            <View style={styles.miniLines}>
                                                <View style={styles.miniLineLong} />
                                                <View style={[styles.miniLineShort, { backgroundColor: `${themeConfig.primary}40` }]} />
                                            </View>
                                        </View>
                                        <View style={styles.miniChatItem}>
                                            <View style={styles.miniAvatar} />
                                            <View style={styles.miniLines}>
                                                <View style={styles.miniLineLong} />
                                                <View style={styles.miniLineShort} />
                                            </View>
                                        </View>
                                    </View>
                                    <View style={styles.miniNav}>
                                        <View style={[styles.miniNavDot, { backgroundColor: themeConfig.primary }]} />
                                        <View style={styles.miniNavDot} />
                                        <View style={styles.miniNavDot} />
                                    </View>
                                </View>

                                {/* Theme Name */}
                                <View style={styles.themeInfo}>
                                    <Text style={[
                                        styles.themeName,
                                        isSelected && { color: themeConfig.primary }
                                    ]}>
                                        {themeName.replace('-', ' ').toUpperCase()}
                                    </Text>
                                    {isSelected && (
                                        <MaterialIcons name="check-circle" size={20} color={themeConfig.primary} />
                                    )}
                                </View>

                                {/* Color Swatches */}
                                <View style={styles.swatches}>
                                    <View style={[styles.swatch, { backgroundColor: themeConfig.primary }]} />
                                    <View style={[styles.swatch, { backgroundColor: themeConfig.accent }]} />
                                    <View style={[styles.swatch, { backgroundColor: themeConfig.background, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' }]} />
                                </View>
                            </Pressable>
                        );
                    })}
                </View>

                {/* Apply Button */}
                <Pressable
                    style={[styles.applyButton, { backgroundColor: activeTheme.primary }]}
                    onPress={() => {
                        if (navigation.canGoBack()) navigation.goBack();
                    }}
                >
                    <Text style={styles.applyButtonText}>APPLY THEME</Text>
                </Pressable>
            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000000',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 50,
        paddingBottom: 16,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.1)',
    },
    backButton: {
        padding: 8,
    },
    headerTitle: {
        color: '#ffffff',
        fontSize: 16,
        fontWeight: '900',
        letterSpacing: 2,
    },
    placeholder: {
        width: 40,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        padding: 20,
        paddingBottom: 40,
    },
    sectionTitle: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 11,
        fontWeight: '900',
        letterSpacing: 2,
        marginBottom: 20,
    },
    themeGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 16,
    },
    themeCard: {
        width: '47%',
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 16,
        padding: 12,
        borderWidth: 2,
        borderColor: 'transparent',
    },
    themePreview: {
        height: 120,
        borderRadius: 10,
        padding: 8,
        marginBottom: 12,
    },
    miniHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginBottom: 8,
    },
    miniDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    miniLine: {
        flex: 1,
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 2,
    },
    miniChatList: {
        flex: 1,
        gap: 6,
    },
    miniChatItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    miniAvatar: {
        width: 16,
        height: 16,
        borderRadius: 8,
        backgroundColor: 'rgba(255,255,255,0.1)',
    },
    miniLines: {
        flex: 1,
        gap: 3,
    },
    miniLineLong: {
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.15)',
        borderRadius: 2,
        width: '80%',
    },
    miniLineShort: {
        height: 3,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 2,
        width: '50%',
    },
    miniNav: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        marginTop: 8,
    },
    miniNavDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: 'rgba(255,255,255,0.2)',
    },
    themeInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    themeName: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 10,
        fontWeight: '800',
        letterSpacing: 1,
    },
    swatches: {
        flexDirection: 'row',
        gap: 6,
    },
    swatch: {
        width: 20,
        height: 20,
        borderRadius: 10,
    },
    applyButton: {
        marginTop: 32,
        paddingVertical: 16,
        borderRadius: 16,
        alignItems: 'center',
    },
    applyButtonText: {
        color: '#ffffff',
        fontSize: 14,
        fontWeight: '900',
        letterSpacing: 2,
    },
});
