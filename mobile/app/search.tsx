import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TextInput, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Platform, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SERVER_URL, safeFetchJson, proxySupabaseUrl } from '../config/api';
import { useApp } from '../context/AppContext';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import GlassView from '../components/ui/GlassView';
import { SoulAvatar } from '../components/SoulAvatar';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInDown, FadeInRight } from 'react-native-reanimated';

export default function SearchScreen() {
    const { currentUser } = useApp();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const [searchError, setSearchError] = useState<string | null>(null);
    const router = useRouter();

    const searchUsers = useCallback(async (text: string) => {
        if (text.length < 2) {
            setResults([]);
            setSearchError(null);
            return;
        }
        setLoading(true);
        setSearchError(null);
        try {
            const { success, data, error } = await safeFetchJson<any>(
                `${SERVER_URL}/api/users/search?query=${encodeURIComponent(text)}`,
                {
                    headers: { 'x-user-id': currentUser?.id || '' }
                }
            );

            if (success && data?.success) {
                setResults(data.users || []);
            } else {
                setSearchError(error || 'Search failed');
            }
        } catch (err: any) {
            setSearchError(err?.message || 'Network error');
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
        setConnectingId(receiverId);
        try {
            const { success, data, error } = await safeFetchJson<any>(
                `${SERVER_URL}/api/connections/request`, 
                {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'x-user-id': currentUser?.id || ''
                    },
                    body: JSON.stringify({ receiverId })
                }
            );

            if (success && data?.success) {
                setResults(prev => prev.map(u => u.id === receiverId ? { ...u, connectionStatus: 'request_sent' } : u));
            } else {
                Alert.alert('Error', error || 'Failed to send request');
            }
        } catch (err) {
            console.warn('[Search] Request error:', err);
        } finally {
            setConnectingId(null);
        }
    };

    const handleAccept = async (userId: string) => {
        setConnectingId(userId);
        try {
            // First find the request ID (in search results, data usually has connectionStatus received)
            // But let's check if the server endpoint supports accepting by userId OR if we need to fetch requests first
            // Based on server/index.js, it's PUT /api/connections/request/:requestId/accept
            // So we need the requestId. 
            // In a better implementation, the enriched search results should include the requestId if it exists.
            
            // Let's first fetch pending requests to get the correct ID
            const { data: reqData } = await safeFetchJson<any>(`${SERVER_URL}/api/connections/requests`, {
                headers: { 'x-user-id': currentUser?.id || '' }
            });
            
            const incomingReq = reqData?.incoming?.find(r => r.sender_id === userId);
            if (!incomingReq) {
                // If not found, maybe just redirect to requests screen
                router.push('/requests');
                return;
            }

            const { success, error } = await safeFetchJson<any>(
                `${SERVER_URL}/api/connections/request/${incomingReq.id}/accept`,
                {
                    method: 'PUT',
                    headers: { 'x-user-id': currentUser?.id || '' }
                }
            );

            if (success) {
                setResults(prev => prev.map(u => u.id === userId ? { ...u, connectionStatus: 'connected' } : u));
            } else {
                Alert.alert('Error', error || 'Failed to accept');
            }
        } catch (err) {
            console.error('[Search] Accept error:', err);
        } finally {
            setConnectingId(null);
        }
    };

    const handleCancel = async (userId: string) => {
        setConnectingId(userId);
        try {
            const { data: reqData } = await safeFetchJson<any>(`${SERVER_URL}/api/connections/requests`, {
                headers: { 'x-user-id': currentUser?.id || '' }
            });
            
            const outgoingReq = reqData?.outgoing?.find(r => r.receiver_id === userId);
            if (!outgoingReq) return;

            const { success } = await safeFetchJson<any>(
                `${SERVER_URL}/api/connections/request/${outgoingReq.id}/cancel`,
                {
                    method: 'DELETE',
                    headers: { 'x-user-id': currentUser?.id || '' }
                }
            );

            if (success) {
                setResults(prev => prev.map(u => u.id === userId ? { ...u, connectionStatus: 'not_connected' } : u));
            }
        } catch (err) {
            console.error('[Search] Cancel error:', err);
        } finally {
            setConnectingId(null);
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
                        <Text style={styles.fullName}>{item.display_name || item.full_name || `@${item.username}`}</Text>
                    </View>
                    
                    {item.connectionStatus === 'not_connected' && (
                        <TouchableOpacity 
                            style={styles.connectButtonWrapper} 
                            onPress={() => sendRequest(item.id)}
                            disabled={connectingId === item.id}
                        >
                            <LinearGradient
                                colors={['#3b82f6', '#2563eb']}
                                style={styles.connectButton}
                            >
                                {connectingId === item.id ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                ) : (
                                    <Text style={styles.connectText}>Connect</Text>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                    )}
                    
                    {item.connectionStatus === 'request_sent' && (
                        <TouchableOpacity style={styles.pendingBadge} onPress={() => handleCancel(item.id)}>
                            {connectingId === item.id ? (
                                <ActivityIndicator size="small" color="rgba(255,255,255,0.4)" />
                            ) : (
                                <>
                                    <MaterialIcons name="hourglass-empty" size={14} color="rgba(255,255,255,0.6)" />
                                    <Text style={styles.pendingText}>Sent</Text>
                                </>
                            )}
                        </TouchableOpacity>
                    )}

                    {item.connectionStatus === 'request_received' && (
                        <TouchableOpacity 
                            style={[styles.connectButtonWrapper]} 
                            onPress={() => handleAccept(item.id)}
                            disabled={connectingId === item.id}
                        >
                            <LinearGradient
                                colors={['#22c55e', '#16a34a']}
                                style={styles.connectButton}
                            >
                                {connectingId === item.id ? (
                                    <ActivityIndicator size="small" color="#fff" />
                                ) : (
                                    <Text style={styles.connectText}>Accept</Text>
                                )}
                            </LinearGradient>
                        </TouchableOpacity>
                    )}
                    
                    {item.connectionStatus === 'connected' && (
                        <TouchableOpacity 
                            style={styles.chatButton} 
                            onPress={() => router.push(`/chat/${item.id}`)}
                        >
                            <LinearGradient
                                colors={['#3b82f6', '#2563eb']}
                                style={styles.chatButtonGradient}
                            >
                                <MaterialIcons name="chat" size={20} color="#fff" />
                            </LinearGradient>
                        </TouchableOpacity>
                    )}
                </View>
            </View>
        </Animated.View>
    );

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#000000', '#080808']} style={StyleSheet.absoluteFill} />
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
                            <Text style={styles.emptyText}>
                                {searchError ? 'Could not connect to server' : `No users found named "${query}"`}
                            </Text>
                        </View>
                    ) : !loading && query.length < 2 ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.hintText}>Type at least 2 characters to search</Text>
                        </View>
                    ) : null
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
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderRadius: 22,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
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
    userCard: { height: 84, borderRadius: 24, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
    glassBackground: { ...StyleSheet.absoluteFillObject },
    cardContent: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
    userInfo: { flex: 1, marginLeft: 16 },
    username: { color: '#fff', fontSize: 17, fontWeight: '700' },
    fullName: { color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 2 },
    connectButtonWrapper: { borderRadius: 20, overflow: 'hidden' },
    connectButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, minWidth: 90, alignItems: 'center' },
    connectText: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },
    pendingBadge: { 
        flexDirection: 'row', 
        alignItems: 'center', 
        backgroundColor: 'rgba(255,255,255,0.08)', 
        paddingHorizontal: 14, 
        paddingVertical: 8, 
        borderRadius: 18,
        gap: 6,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)'
    },
    pendingText: { color: 'rgba(255,255,255,0.5)', fontWeight: '600', fontSize: 13 },
    chatButton: { 
        width: 44, 
        height: 44, 
        borderRadius: 22, 
        overflow: 'hidden',
        shadowColor: '#3b82f6',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 4
    },
    chatButtonGradient: {
        flex: 1,
        justifyContent: 'center', 
        alignItems: 'center',
    },
    emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 100 },
    emptyText: { color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 16, fontSize: 16, fontWeight: '500' },
    hintText: { color: 'rgba(255,255,255,0.2)', textAlign: 'center', fontSize: 15, fontWeight: '500' }
});
