import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Image, Platform } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { SERVER_URL, serverFetch, proxySupabaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { MaterialIcons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown } from 'react-native-reanimated';

export default function SearchScreen() {
    const { currentUser } = useApp();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const searchUsers = useCallback(async (text: string) => {
        if (text.length < 2) {
            setResults([]);
            return;
        }
        setLoading(true);
        try {
            // Using currentUserId in both header (mock auth) and query
            const resp = await serverFetch(`${SERVER_URL}/api/users/search?query=${encodeURIComponent(text)}`, {
                headers: {
                    'x-user-id': currentUser?.id || ''
                }
            });
            const data = await resp.json() as any;
            if (data.success) {
                setResults(data.users);
            }
        } catch (err) {
            console.error('Search failed:', err);
        } finally {
            setLoading(false);
        }
    }, [currentUser]);

    useEffect(() => {
        const timer = setTimeout(() => {
            searchUsers(query);
        }, 500);
        return () => clearTimeout(timer);
    }, [query, searchUsers]);

    const sendRequest = async (receiverId: string) => {
        try {
            const resp = await serverFetch(`${SERVER_URL}/api/connections/request`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-user-id': currentUser?.id || ''
                },
                body: JSON.stringify({ receiverId })
            });
            const data = await resp.json() as any;
            if (data.success) {
                // Update local status optimistically
                setResults(prev => prev.map(u => u.id === receiverId ? { ...u, connectionStatus: 'request_sent' } : u));
            }
        } catch (err) {
            console.error('Request failed:', err);
        }
    };

    const renderItem = ({ item, index }: { item: any; index: number }) => (
        <Animated.View entering={FadeInDown.delay(index * 50).duration(400)}>
            <View style={styles.userCard}>
                <GlassView intensity={25} tint="dark" style={styles.glassBackground} />
                <View style={styles.cardContent}>
                    <SoulAvatar uri={proxySupabaseUrl(item.avatar_url)} size={52} />
                    <View style={styles.userInfo}>
                        <Text style={styles.username}>{item.username}</Text>
                        <Text style={styles.fullName}>{item.full_name || `@${item.username}`}</Text>
                    </View>
                    
                    {item.connectionStatus === 'not_connected' && (
                        <TouchableOpacity style={styles.connectButton} onPress={() => sendRequest(item.id)}>
                            <Text style={styles.connectText}>Connect</Text>
                        </TouchableOpacity>
                    )}
                    
                    {item.connectionStatus === 'request_sent' && (
                        <View style={styles.pendingBadge}>
                            <MaterialIcons name="hourglass-empty" size={14} color="rgba(255,255,255,0.6)" />
                            <Text style={styles.pendingText}>Sent</Text>
                        </View>
                    )}

                    {item.connectionStatus === 'request_received' && (
                        <TouchableOpacity 
                            style={[styles.connectButton, { backgroundColor: '#22c55e' }]} 
                            onPress={() => router.push('/requests')} // We'll implement this screen next
                        >
                            <Text style={styles.connectText}>Accept</Text>
                        </TouchableOpacity>
                    )}
                    
                    {item.connectionStatus === 'connected' && (
                        <TouchableOpacity style={styles.chatButton} onPress={() => router.push(`/chat/${item.id}`)}>
                            <MaterialIcons name="chat" size={20} color="#fff" />
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        </Animated.View>
    );

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#1a1a1a', '#000']} style={StyleSheet.absoluteFill} />
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton} activeOpacity={0.7}>
                    <MaterialIcons name="arrow-back-ios" size={20} color="#fff" />
                </TouchableOpacity>
                <View style={styles.searchWrapper}>
                    <GlassView intensity={30} tint="dark" style={styles.searchGlass} />
                    <View style={styles.searchContainer}>
                        <MaterialIcons name="search" size={20} color="rgba(255,255,255,0.5)" />
                        <TextInput
                            style={styles.searchInput}
                            placeholder="Find Soulmates..."
                            placeholderTextColor="rgba(255,255,255,0.4)"
                            value={query}
                            onChangeText={setQuery}
                            autoFocus
                            selectionColor="#3b82f6"
                        />
                        {loading && <ActivityIndicator color="#3b82f6" size="small" />}
                    </View>
                </View>
            </View>

            <FlatList
                data={results}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.list}
                ListEmptyComponent={
                    !loading && query.length >= 2 ? (
                        <View style={styles.emptyContainer}>
                            <MaterialIcons name="person-search" size={60} color="rgba(255,255,255,0.1)" />
                            <Text style={styles.emptyText}>No users found named "{query}"</Text>
                        </View>
                    ) : (
                        !loading && query.length < 2 && (
                            <View style={styles.emptyContainer}>
                                <Text style={styles.hintText}>Type at least 2 characters to search</Text>
                            </View>
                        )
                    )
                }
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    header: { 
        flexDirection: 'row', 
        alignItems: 'center', 
        paddingTop: Platform.OS === 'ios' ? 60 : 40, 
        paddingHorizontal: 20, 
        marginBottom: 20,
        gap: 12
    },
    backButton: { 
        width: 44, 
        height: 44, 
        justifyContent: 'center', 
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 22
    },
    searchWrapper: { flex: 1, height: 48, borderRadius: 24, overflow: 'hidden' },
    searchGlass: { ...StyleSheet.absoluteFillObject },
    searchContainer: { 
        flex: 1, 
        flexDirection: 'row', 
        alignItems: 'center', 
        paddingHorizontal: 15,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
    },
    searchInput: { flex: 1, color: '#fff', fontSize: 16, marginLeft: 10, height: '100%' },
    list: { paddingHorizontal: 20, paddingBottom: 60, flexGrow: 1 },
    userCard: { height: 84, borderRadius: 24, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
    glassBackground: { ...StyleSheet.absoluteFillObject },
    cardContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
    userInfo: { flex: 1, marginLeft: 16 },
    username: { color: '#fff', fontSize: 17, fontWeight: '700' },
    fullName: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 2 },
    connectButton: { backgroundColor: '#3b82f6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
    connectText: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },
    pendingBadge: { 
        flexDirection: 'row', 
        alignItems: 'center', 
        backgroundColor: 'rgba(255,255,255,0.08)', 
        paddingHorizontal: 14, 
        paddingVertical: 8, 
        borderRadius: 18,
        gap: 6
    },
    pendingText: { color: 'rgba(255,255,255,0.5)', fontWeight: '600', fontSize: 13 },
    chatButton: { 
        backgroundColor: '#22c55e', 
        width: 44, 
        height: 44, 
        borderRadius: 22, 
        justifyContent: 'center', 
        alignItems: 'center',
        shadowColor: '#22c55e',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 4
    },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 100 },
    emptyText: { color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 16, fontSize: 16, fontWeight: '500' },
    hintText: { color: 'rgba(255,255,255,0.2)', textAlign: 'center', fontSize: 15, fontWeight: '500' }
});
