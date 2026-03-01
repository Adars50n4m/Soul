import React, { useState, useMemo } from 'react';
import {
    View, Text, StyleSheet, ScrollView, TextInput,
    Pressable, StatusBar, useWindowDimensions, Animated, Platform, Modal
} from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';


const HELP_DATA: Record<string, { title: string, content: string }> = {
    '1': {
        title: 'Get Started',
        content: 'Welcome to SoulSync! To get started, customize your profile in Settings. You can change your avatar, bio, and birthdate to help your contacts recognize you. Start a new chat by tapping the message icon on the Home screen.'
    },
    '2': {
        title: 'Chats',
        content: 'SoulSync offers end-to-end encrypted messaging. You can send text, images, and audio messages. Long-press a message to see more options like reply or delete.'
    },
    '3': {
        title: 'Voice and Video Calls',
        content: 'Experience high-quality audio and video calls. Pulse-style animations notify you of incoming calls. Ensure you have a stable internet connection for the best experience.'
    },
    '4': {
        title: 'Privacy & Security',
        content: 'Your privacy is our priority. SoulSync uses advanced encryption for all communications. You can manage your security settings, including two-step verification, in the Account section of Settings.'
    },
    '5': {
        title: 'Accounts',
        content: 'Manage your SoulSync account details. If you encounter any issues with your account or notice suspicious activity, please report it immediately through the "Report a Problem" section.'
    },
    'a1': {
        title: 'How to make a video call',
        content: 'To make a video call:\n1. Open a chat with the person you want to call.\n2. Tap the Video Camera icon at the top right.\n3. Wait for the contact to accept the call.\n\nYou can switch between front and back cameras during the call.'
    },
    'a2': {
        title: 'How to stay safe on SoulSync',
        content: 'Stay safe by:\n- Never sharing your verification code.\n- Using Two-Step Verification.\n- Highlighting suspicious contacts.\n- Blocking users who make you feel uncomfortable.'
    },
    'a3': {
        title: 'About banned accounts',
        content: 'Accounts may be temporarily banned if they violate our Terms of Service, such as sending spam or engaging in unauthorized automated behavior. If you believe your account was banned by mistake, please contact us.'
    },
    'a4': {
        title: 'Ads in Status',
        content: 'SoulSync is committed to a clean, cinematic experience. While we may introduce subtle sponsorship in Status or Channels in the future, your private chats will always remain ad-free and private.'
    },
};

const HELP_TOPICS = [
    { id: '1', title: 'Get Started', icon: 'flag', color: '#10b981' },
    { id: '2', title: 'Chats', icon: 'chatbox-ellipses', color: '#3b82f6', isIonicons: true },
    { id: '3', title: 'Voice and Video Calls', icon: 'call', color: '#8b5cf6' },
    { id: '4', title: 'Privacy, Safety, and Security', icon: 'lock', color: '#f59e0b' },
    { id: '5', title: 'Accounts and Account Bans', icon: 'person', color: '#ef4444' },
];

const POPULAR_ARTICLES = [
    { id: 'a1', title: 'How to make a video call' },
    { id: 'a2', title: 'How to stay safe on SoulSync' },
    { id: 'a3', title: 'About temporarily banned accounts' },
    { id: 'a4', title: 'About ads in SoulSync Status and Channels' },
];

const TopicItem = ({ topic, onOpen }: { topic: typeof HELP_TOPICS[0], onOpen: (id: string) => void }) => (
    <Pressable style={styles.topicItem} onPress={() => onOpen(topic.id)}>
        <View style={[styles.topicIconContainer, { backgroundColor: `${topic.color}20` }]}>
            {topic.isIonicons ? (
                <Ionicons name={topic.icon as any} size={20} color={topic.color} />
            ) : (
                <MaterialIcons name={topic.icon as any} size={20} color={topic.color} />
            )}
        </View>
        <Text style={styles.topicTitle}>{topic.title}</Text>
        <MaterialIcons name="chevron-right" size={24} color="rgba(255,255,255,0.2)" />
    </Pressable>
);

const ArticleItem = ({ article, onOpen, primaryColor }: { article: typeof POPULAR_ARTICLES[0], onOpen: (id: string) => void, primaryColor: string }) => (
    <Pressable style={styles.articleItem} onPress={() => onOpen(article.id)}>
        <MaterialIcons name="description" size={20} color={primaryColor} style={styles.articleIcon} />
        <Text style={styles.articleTitle}>{article.title}</Text>
        <MaterialIcons name="chevron-right" size={20} color="rgba(255,255,255,0.2)" />
    </Pressable>
);

export default function HelpCenterScreen() {
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const { activeTheme } = useApp();
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedArticle, setSelectedArticle] = useState<{id: string, title: string, content: string} | null>(null);

    const filteredTopics = useMemo(() => {
        if (!searchQuery) return HELP_TOPICS;
        return HELP_TOPICS.filter(t => t.title.toLowerCase().includes(searchQuery.toLowerCase()));
    }, [searchQuery]);

    const filteredArticles = useMemo(() => {
        if (!searchQuery) return POPULAR_ARTICLES;
        return POPULAR_ARTICLES.filter(a => a.title.toLowerCase().includes(searchQuery.toLowerCase()));
    }, [searchQuery]);

    const openArticle = (id: string) => {
        const data = HELP_DATA[id];
        if (data) {
            setSelectedArticle({ id, ...data });
        }
    };

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />
            
            {/* Header */}
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.headerButton}>
                    <MaterialIcons name="arrow-back" size={24} color="white" />
                </Pressable>
                <Text style={styles.headerTitle}>Help Center</Text>
                <Pressable style={styles.headerButton}>
                    <Ionicons name="share-outline" size={22} color="white" />
                </Pressable>
            </View>

            <ScrollView 
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                {/* Hero Section */}
                <View style={styles.heroSection}>
                    <View style={[styles.logoContainer, { borderColor: activeTheme.primary }]}>
                        <Ionicons name="chatbubbles" size={40} color={activeTheme.primary} />
                    </View>
                    <Text style={styles.heroTitle}>How can we help?</Text>
                </View>

                {/* Search Bar */}
                <View style={styles.searchContainer}>
                    <BlurView intensity={20} tint="light" style={styles.searchBlur} experimentalBlurMethod="dimezisBlurView">
                        <MaterialIcons name="search" size={22} color="rgba(255,255,255,0.5)" />
                        <TextInput
                            style={styles.searchInput}
                            placeholder="Search Help Center"
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                        />
                    </BlurView>
                </View>

                {/* Help Topics */}
                {filteredTopics.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionHeader}>Help Topics</Text>
                        <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                            {filteredTopics.map((topic, index) => (
                                <View key={topic.id}>
                                    <TopicItem topic={topic} onOpen={openArticle} />
                                    {index < filteredTopics.length - 1 && <View style={styles.separator} />}
                                </View>
                            ))}
                        </BlurView>
                    </View>
                )}

                {/* Popular Articles */}
                {filteredArticles.length > 0 && (
                    <View style={styles.section}>
                        <Text style={styles.sectionHeader}>Popular Articles</Text>
                        <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                            {filteredArticles.map((article, index) => (
                                <View key={article.id}>
                                    <ArticleItem article={article} onOpen={openArticle} primaryColor={activeTheme.primary} />
                                    {index < filteredArticles.length - 1 && <View style={styles.separator} />}
                                </View>
                            ))}
                        </BlurView>
                    </View>
                )}

                {filteredTopics.length === 0 && filteredArticles.length === 0 && (
                    <View style={styles.emptyResults}>
                        <Text style={styles.emptyText}>No results found for &quot;{searchQuery}&quot;</Text>
                    </View>
                )}

                {/* Footer Center */}
                <View style={styles.footer}>
                    <Ionicons name="people-outline" size={40} color="rgba(255,255,255,0.3)" />
                    <Pressable>
                        <Text style={styles.footerLink}>Need more help?</Text>
                    </Pressable>
                </View>
            </ScrollView>

            {/* Article Modal */}
            <Modal
                visible={!!selectedArticle}
                transparent
                animationType="slide"
                onRequestClose={() => setSelectedArticle(null)}
            >
                <View style={styles.modalOverlay}>
                    <BlurView intensity={80} tint="dark" style={styles.modalContent} experimentalBlurMethod="dimezisBlurView">
                        <View style={styles.modalHeader}>
                            <Pressable onPress={() => setSelectedArticle(null)} style={styles.closeBtn}>
                                <MaterialIcons name="close" size={24} color="white" />
                            </Pressable>
                            <Text style={styles.modalTitle} numberOfLines={1}>{selectedArticle?.title}</Text>
                        </View>
                        <ScrollView contentContainerStyle={styles.modalScroll}>
                            <Text style={styles.articleBody}>{selectedArticle?.content}</Text>
                        </ScrollView>
                    </BlurView>
                </View>
            </Modal>
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
        paddingTop: Platform.OS === 'ios' ? 60 : 40,
        paddingHorizontal: 16,
        paddingBottom: 16,
        backgroundColor: 'rgba(0,0,0,0.8)',
    },
    headerButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: '#fff',
    },
    scrollContent: {
        paddingBottom: 40,
    },
    heroSection: {
        alignItems: 'center',
        marginTop: 20,
        marginBottom: 30,
    },
    logoContainer: {
        width: 70,
        height: 70,
        borderRadius: 35,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    heroTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        color: '#fff',
        letterSpacing: -0.5,
    },
    searchContainer: {
        paddingHorizontal: 20,
        marginBottom: 25,
    },
    searchBlur: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 12,
        paddingHorizontal: 12,
        height: 50,
        overflow: 'hidden',
    },
    searchInput: {
        flex: 1,
        height: '100%',
        color: '#fff',
        fontSize: 16,
        marginLeft: 10,
    },
    section: {
        paddingHorizontal: 16,
        marginBottom: 25,
    },
    sectionHeader: {
        fontSize: 18,
        fontWeight: '600',
        color: '#fff',
        marginBottom: 12,
        marginLeft: 4,
    },
    glassContainer: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    topicItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
    },
    topicIconContainer: {
        width: 40,
        height: 40,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 16,
    },
    topicTitle: {
        flex: 1,
        color: '#fff',
        fontSize: 16,
        fontWeight: '500',
    },
    separator: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.05)',
        marginLeft: 72,
    },
    articleItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
    },
    articleIcon: {
        marginRight: 16,
        opacity: 0.8,
    },
    articleTitle: {
        flex: 1,
        color: 'rgba(255,255,255,0.8)',
        fontSize: 15,
    },
    footer: {
        alignItems: 'center',
        marginTop: 20,
        paddingBottom: 20,
    },
    footerLink: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#fff',
        marginTop: 10,
        textDecorationLine: 'underline',
    },
    emptyResults: {
        alignItems: 'center',
        padding: 40,
    },
    emptyText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 16,
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalContent: {
        height: '70%',
        borderTopLeftRadius: 30,
        borderTopRightRadius: 30,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderTopColor: 'rgba(255,255,255,0.1)',
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.05)',
    },
    closeBtn: {
        marginRight: 15,
    },
    modalTitle: {
        flex: 1,
        fontSize: 18,
        fontWeight: 'bold',
        color: 'white',
    },
    modalScroll: {
        padding: 20,
        paddingBottom: 100,
    },
    articleBody: {
        color: 'rgba(255,255,255,0.8)',
        fontSize: 16,
        lineHeight: 24,
    }
});
