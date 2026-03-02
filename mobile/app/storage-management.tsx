import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    View, Text, StyleSheet, Pressable, StatusBar, ScrollView,
    Image, Dimensions, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../context/AppContext';
import BreakdownItem from '../components/storage/BreakdownItem';
import ChatStorageItem from '../components/storage/ChatStorageItem';
import { useWindowDimensions } from 'react-native';





interface StorageInfo {
    totalDevice: number;
    freeDevice: number;
    usedDevice: number;
    appCacheSize: number;
    dbSize: number;
}

interface ChatStorageInfo {
    chatId: string;
    contactName: string;
    avatar: string;
    totalMessages: number;
    mediaMessages: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
    fileCount: number;
}

interface MediaItem {
    messageId: string;
    chatId: string;
    contactName: string;
    mediaType: 'image' | 'video' | 'audio' | 'file' | 'status_reply';
    mediaUrl: string;
    mediaName?: string;
    timestamp: string;
}

const formatBytes = (bytes: number, decimals = 1): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
};

const getMediaIcon = (type: string): string => {
    switch (type) {
        case 'image': return 'image';
        case 'video': return 'videocam';
        case 'audio': return 'audiotrack';
        case 'file': return 'insert-drive-file';
        default: return 'attachment';
    }
};

const getMediaColor = (type: string): string => {
    switch (type) {
        case 'image': return '#10b981';
        case 'video': return '#3b82f6';
        case 'audio': return '#f59e0b';
        case 'file': return '#8b5cf6';
        default: return '#6b7280';
    }
};

export default function StorageManagementScreen() {
    const { width } = useWindowDimensions();
    const GRID_ITEM_SIZE = (width - 32 - 8) / 3;

    const router = useRouter();
    const { activeTheme, messages, contacts, deleteMessage } = useApp();

    const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
    const [isSelecting, setIsSelecting] = useState(false);
    const [clearingCache, setClearingCache] = useState(false);

    // Fetch device + app storage info
    const fetchStorageInfo = useCallback(async () => {
        try {
            const freeDiskInfo = await FileSystem.getFreeDiskStorageAsync();
            const totalDiskInfo = await FileSystem.getTotalDiskCapacityAsync();
            const totalBytes = totalDiskInfo;
            const freeBytes = freeDiskInfo;

            let dbSize = 0;
            let appCacheSize = 0;

            // SQLite DB size
            const dbPath = `${FileSystem.documentDirectory}SQLite/soulsync.db`;
            try {
                const dbInfo = await FileSystem.getInfoAsync(dbPath);
                if (dbInfo.exists && 'size' in dbInfo) {
                    dbSize = dbInfo.size || 0;
                }
            } catch {}

            // Cache directory size
            try {
                if (FileSystem.cacheDirectory) {
                    const files = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
                    const sizes = await Promise.all(
                        files.map(async (file) => {
                            try {
                                const info = await FileSystem.getInfoAsync(
                                    `${FileSystem.cacheDirectory}${file}`
                                );
                                return info.exists && 'size' in info ? (info.size || 0) : 0;
                            } catch { return 0; }
                        })
                    );
                    appCacheSize = sizes.reduce((a, b) => a + b, 0);
                }
            } catch {}

            setStorageInfo({
                totalDevice: totalBytes,
                freeDevice: freeBytes,
                usedDevice: totalBytes - freeBytes,
                appCacheSize,
                dbSize,
            });
            setLoading(false);
        } catch (e) {
            console.error('Failed to get storage info:', e);
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        // Defer to avoid synchronous setState warning
        Promise.resolve().then(() => {
            fetchStorageInfo();
        });
    }, [fetchStorageInfo]);

    // Per-chat storage computation
    const chatStorageData = useMemo((): ChatStorageInfo[] => {
        return Object.entries(messages).map(([chatId, msgs]) => {
            const contact = contacts.find(c => c.id === chatId);
            const mediaMessages = msgs.filter(m => m.media);

            return {
                chatId,
                contactName: contact?.name || 'Unknown',
                avatar: contact?.avatar || '',
                totalMessages: msgs.length,
                mediaMessages: mediaMessages.length,
                imageCount: mediaMessages.filter(m => m.media?.type === 'image').length,
                videoCount: mediaMessages.filter(m => m.media?.type === 'video').length,
                audioCount: mediaMessages.filter(m => m.media?.type === 'audio').length,
                fileCount: mediaMessages.filter(m => m.media?.type === 'file').length,
            };
        }).filter(c => c.totalMessages > 0)
          .sort((a, b) => b.mediaMessages - a.mediaMessages);
    }, [messages, contacts]);

    // All media items for the grid
    const mediaItems = useMemo((): MediaItem[] => {
        const items: MediaItem[] = [];
        Object.entries(messages).forEach(([chatId, msgs]) => {
            const contact = contacts.find(c => c.id === chatId);
            msgs.forEach(msg => {
                if (msg.media && msg.media.url && msg.media.type !== 'status_reply') {
                    items.push({
                        messageId: msg.id,
                        chatId,
                        contactName: contact?.name || 'Unknown',
                        mediaType: msg.media.type,
                        mediaUrl: msg.media.url,
                        mediaName: msg.media.name,
                        timestamp: msg.timestamp,
                    });
                }
            });
        });
        // Videos first, then images, then rest
        return items.sort((a, b) => {
            const order: Record<string, number> = { video: 0, image: 1, file: 2, audio: 3 };
            return (order[a.mediaType] ?? 4) - (order[b.mediaType] ?? 4);
        });
    }, [messages, contacts]);

    const totalMediaCount = mediaItems.length;

    // Toggle item selection
    const toggleSelectItem = useCallback((chatId: string, messageId: string) => {
        const compositeId = `${chatId}::${messageId}`;
        setSelectedItems(prev => {
            const next = new Set(prev);
            if (next.has(compositeId)) {
                next.delete(compositeId);
            } else {
                next.add(compositeId);
            }
            return next;
        });
    }, []);

    // Delete selected media messages
    const handleDeleteSelected = useCallback(() => {
        if (selectedItems.size === 0) return;
        Alert.alert(
            'Delete Selected',
            `Delete ${selectedItems.size} media item${selectedItems.size > 1 ? 's' : ''}? This cannot be undone.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        selectedItems.forEach(compositeId => {
                            const [chatId, messageId] = compositeId.split('::');
                            deleteMessage(chatId, messageId);
                        });
                        setSelectedItems(new Set());
                        setIsSelecting(false);
                    },
                },
            ]
        );
    }, [selectedItems, deleteMessage]);

    // Clear cache
    const handleClearCache = useCallback(() => {
        Alert.alert(
            'Clear Cache',
            'This will clear cached files and temporary data. Your messages will be preserved.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Clear',
                    style: 'destructive',
                    onPress: async () => {
                        setClearingCache(true);
                        try {
                            if (FileSystem.cacheDirectory) {
                                const files = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
                                await Promise.all(
                                    files.map(file =>
                                        FileSystem.deleteAsync(
                                            `${FileSystem.cacheDirectory}${file}`,
                                            { idempotent: true }
                                        )
                                    )
                                );
                            }
                            Alert.alert('Done', 'Cache cleared successfully');
                            fetchStorageInfo();
                            setClearingCache(false);
                        } catch {
                            Alert.alert('Error', 'Failed to clear cache');
                            setClearingCache(false);
                        }
                    },
                },
            ]
        );
    }, [fetchStorageInfo]);

    // Clear all data
    const handleClearAllData = useCallback(() => {
        Alert.alert(
            'Clear All Data',
            'This will delete all local messages, cached data, and reset preferences. This cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete Everything',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await AsyncStorage.clear();
                            if (FileSystem.cacheDirectory) {
                                const files = await FileSystem.readDirectoryAsync(FileSystem.cacheDirectory);
                                await Promise.all(
                                    files.map(f =>
                                        FileSystem.deleteAsync(`${FileSystem.cacheDirectory}${f}`, { idempotent: true })
                                    )
                                );
                            }
                            const dbPath = `${FileSystem.documentDirectory}SQLite/soulsync.db`;
                            await FileSystem.deleteAsync(dbPath, { idempotent: true });
                            Alert.alert('Done', 'All data cleared. Please restart the app.');
                        } catch {
                            Alert.alert('Error', 'Failed to clear data');
                        }
                    },
                },
            ]
        );
    }, []);

    // Loading state
    if (loading) {
        return (
            <View style={styles.container}>
                <StatusBar barStyle="light-content" />
                <View style={styles.header}>
                    <Pressable onPress={() => router.back()} style={styles.headerButton}>
                        <MaterialIcons name="arrow-back" size={24} color="white" />
                    </Pressable>
                    <Text style={styles.headerTitle}>Manage Storage</Text>
                    <View style={{ width: 40 }} />
                </View>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={activeTheme.primary} />
                    <Text style={styles.loadingText}>Calculating storage...</Text>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar barStyle="light-content" />

            {/* Header */}
            <View style={styles.header}>
                <Pressable onPress={() => router.back()} style={styles.headerButton}>
                    <MaterialIcons name="arrow-back" size={24} color="white" />
                </Pressable>
                <Text style={styles.headerTitle}>Manage Storage</Text>
                <View style={{ width: 40 }} />
            </View>

            <ScrollView
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                {/* Section 1: Device Storage Overview */}
                {storageInfo && (
                    <View style={styles.section}>
                        <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                            <View style={styles.storageHeaderRow}>
                                <Text style={styles.storageUsedLabel}>Used</Text>
                                <Text style={styles.storageFreeLabel}>
                                    {formatBytes(storageInfo.freeDevice)} free
                                </Text>
                            </View>
                            <Text style={[styles.storageUsedValue, { color: activeTheme.primary }]}>
                                {formatBytes(storageInfo.usedDevice)}
                            </Text>

                            {/* Storage Bar */}
                            <View style={styles.storageBar}>
                                <View style={[
                                    styles.storageSegment,
                                    {
                                        flex: Math.max(storageInfo.usedDevice / storageInfo.totalDevice, 0.01),
                                        backgroundColor: activeTheme.primary,
                                        borderTopLeftRadius: 6,
                                        borderBottomLeftRadius: 6,
                                    }
                                ]} />
                                <View style={[
                                    styles.storageSegment,
                                    {
                                        flex: Math.max(storageInfo.freeDevice / storageInfo.totalDevice, 0.01),
                                        backgroundColor: 'rgba(255,255,255,0.1)',
                                        borderTopRightRadius: 6,
                                        borderBottomRightRadius: 6,
                                    }
                                ]} />
                            </View>

                            {/* Legend */}
                            <View style={styles.storageLegend}>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: activeTheme.primary }]} />
                                    <Text style={styles.legendLabel}>Used</Text>
                                </View>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: 'rgba(255,255,255,0.2)' }]} />
                                    <Text style={styles.legendLabel}>Free</Text>
                                </View>
                            </View>
                        </BlurView>
                    </View>
                )}

                {/* Section 2: SoulSync App Storage */}
                <View style={styles.section}>
                    <Text style={styles.sectionHeader}>SoulSync Storage</Text>
                    <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                        <View style={styles.appStorageHeader}>
                            <View style={[styles.appIconContainer, { backgroundColor: `${activeTheme.primary}20` }]}>
                                <Ionicons name="infinite" size={24} color={activeTheme.primary} />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.appStorageTitle}>SoulSync</Text>
                                <Text style={styles.appStorageSubtitle}>
                                    {formatBytes((storageInfo?.dbSize || 0) + (storageInfo?.appCacheSize || 0))}
                                </Text>
                            </View>
                        </View>
                        <View style={styles.separatorFull} />
                        <BreakdownItem icon="storage" label="Database" value={formatBytes(storageInfo?.dbSize || 0)} color="#3b82f6" />
                        <BreakdownItem icon="cached" label="Cache" value={formatBytes(storageInfo?.appCacheSize || 0)} color="#f59e0b" />
                        <BreakdownItem icon="perm-media" label={`Media`} value={`${totalMediaCount} items`} color="#10b981" />
                    </BlurView>
                </View>

                {/* Section 3: Review & Delete Media */}
                <View style={styles.section}>
                    <View style={styles.sectionHeaderRow}>
                        <Text style={styles.sectionHeader}>Review and Delete Items</Text>
                        {mediaItems.length > 0 && (
                            <Pressable onPress={() => {
                                if (isSelecting) {
                                    setIsSelecting(false);
                                    setSelectedItems(new Set());
                                } else {
                                    setIsSelecting(true);
                                }
                            }}>
                                <Text style={[styles.selectText, { color: activeTheme.primary }]}>
                                    {isSelecting ? 'Cancel' : 'Select'}
                                </Text>
                            </Pressable>
                        )}
                    </View>

                    {mediaItems.length > 0 ? (
                        <>
                            <View style={styles.mediaGrid}>
                                {mediaItems.slice(0, 12).map((item) => {
                                    const compositeId = `${item.chatId}::${item.messageId}`;
                                    const isSelected = selectedItems.has(compositeId);

                                    return (
                                        <Pressable
                                            key={compositeId}
                                            style={[
                                                styles.mediaGridItem,
                                                { width: GRID_ITEM_SIZE, height: GRID_ITEM_SIZE },
                                                isSelected && { borderColor: activeTheme.primary, borderWidth: 2 }
                                            ]}

                                            onPress={() => {
                                                if (isSelecting) {
                                                    toggleSelectItem(item.chatId, item.messageId);
                                                }
                                            }}
                                            onLongPress={() => {
                                                if (!isSelecting) {
                                                    setIsSelecting(true);
                                                }
                                                toggleSelectItem(item.chatId, item.messageId);
                                            }}
                                        >
                                            {item.mediaType === 'image' ? (
                                                <Image
                                                    source={{ uri: item.mediaUrl }}
                                                    style={styles.mediaThumbnail}
                                                    resizeMode="cover"
                                                />
                                            ) : item.mediaType === 'video' ? (
                                                <View style={[styles.mediaThumbnail, styles.mediaPlaceholder]}>
                                                    <MaterialIcons name="videocam" size={32} color={getMediaColor('video')} />
                                                    <Text style={styles.mediaTypeLabel}>VIDEO</Text>
                                                </View>
                                            ) : (
                                                <View style={[styles.mediaThumbnail, styles.mediaPlaceholder]}>
                                                    <MaterialIcons
                                                        name={getMediaIcon(item.mediaType) as any}
                                                        size={32}
                                                        color={getMediaColor(item.mediaType)}
                                                    />
                                                    <Text style={styles.mediaTypeLabel}>
                                                        {item.mediaType.toUpperCase()}
                                                    </Text>
                                                </View>
                                            )}

                                            {/* Type badge */}
                                            <View style={styles.mediaTypeBadge}>
                                                <MaterialIcons
                                                    name={getMediaIcon(item.mediaType) as any}
                                                    size={11}
                                                    color="white"
                                                />
                                            </View>

                                            {/* Selection checkbox */}
                                            {isSelecting && (
                                                <View style={[
                                                    styles.selectionCheckbox,
                                                    isSelected && { backgroundColor: activeTheme.primary, borderColor: activeTheme.primary }
                                                ]}>
                                                    {isSelected && (
                                                        <MaterialIcons name="check" size={14} color="white" />
                                                    )}
                                                </View>
                                            )}
                                        </Pressable>
                                    );
                                })}
                            </View>

                            {/* Show more indicator */}
                            {mediaItems.length > 12 && (
                                <Text style={styles.moreItemsText}>
                                    +{mediaItems.length - 12} more items
                                </Text>
                            )}

                            {/* Delete selected button */}
                            {isSelecting && selectedItems.size > 0 && (
                                <Pressable
                                    style={[styles.deleteSelectedBtn, { backgroundColor: '#ef4444' }]}
                                    onPress={handleDeleteSelected}
                                >
                                    <MaterialIcons name="delete" size={20} color="white" />
                                    <Text style={styles.deleteSelectedText}>
                                        Delete {selectedItems.size} item{selectedItems.size > 1 ? 's' : ''}
                                    </Text>
                                </Pressable>
                            )}
                        </>
                    ) : (
                        <View style={styles.emptyState}>
                            <MaterialIcons name="photo-library" size={48} color="rgba(255,255,255,0.15)" />
                            <Text style={styles.emptyText}>No media items to review</Text>
                        </View>
                    )}
                </View>

                {/* Section 4: Per-Chat Storage */}
                <View style={styles.section}>
                    <Text style={styles.sectionHeader}>Chat Storage</Text>
                    <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                        {chatStorageData.length > 0 ? (
                            chatStorageData.map((chat, index) => (
                                <ChatStorageItem 
                                    key={chat.chatId} 
                                    chat={chat} 
                                    isLast={index === chatStorageData.length - 1} 
                                />
                            ))
                        ) : (


                            <View style={styles.emptyChatStorage}>
                                <MaterialIcons name="chat-bubble-outline" size={36} color="rgba(255,255,255,0.15)" />
                                <Text style={styles.emptyText}>No chat data yet</Text>
                            </View>
                        )}
                    </BlurView>
                </View>

                {/* Section 5: Actions */}
                <View style={styles.section}>
                    <Text style={styles.sectionHeader}>Actions</Text>
                    <BlurView intensity={10} tint="dark" style={styles.glassContainer} experimentalBlurMethod="dimezisBlurView">
                        <Pressable style={styles.actionItem} onPress={handleClearCache}>
                            <View style={[styles.actionIcon, { backgroundColor: 'rgba(245,158,11,0.15)' }]}>
                                <MaterialIcons name="cleaning-services" size={22} color="#f59e0b" />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.actionTitle}>Clear Cache</Text>
                                <Text style={styles.actionSubtitle}>
                                    Free up {formatBytes(storageInfo?.appCacheSize || 0)}
                                </Text>
                            </View>
                            {clearingCache ? (
                                <ActivityIndicator color={activeTheme.primary} size="small" />
                            ) : (
                                <MaterialIcons name="chevron-right" size={24} color="rgba(255,255,255,0.2)" />
                            )}
                        </Pressable>
                        <View style={styles.separator} />
                        <Pressable style={styles.actionItem} onPress={handleClearAllData}>
                            <View style={[styles.actionIcon, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                                <MaterialIcons name="delete-forever" size={22} color="#ef4444" />
                            </View>
                            <View style={{ flex: 1 }}>
                                <Text style={[styles.actionTitle, { color: '#ef4444' }]}>Clear All Data</Text>
                                <Text style={styles.actionSubtitle}>
                                    Delete messages, cache, and preferences
                                </Text>
                            </View>
                            <MaterialIcons name="chevron-right" size={24} color="rgba(255,255,255,0.2)" />
                        </Pressable>
                    </BlurView>
                </View>
            </ScrollView>
        </View>
    );
}

// Sub-component: Breakdown Item


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
    },
    headerButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.05)',
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: '#fff',
    },
    scrollContent: {
        paddingBottom: 40,
    },
    section: {
        paddingHorizontal: 16,
        marginBottom: 28,
    },
    sectionHeader: {
        fontSize: 16,
        fontWeight: '700',
        color: 'rgba(255,255,255,0.5)',
        marginBottom: 12,
        marginLeft: 4,
        letterSpacing: 0.5,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    glassContainer: {
        backgroundColor: 'rgba(255,255,255,0.03)',
        borderRadius: 20,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    separator: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.05)',
        marginLeft: 56,
    },
    separatorFull: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.05)',
    },

    // Device Storage
    storageHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: 20,
    },
    storageUsedLabel: {
        fontSize: 14,
        color: 'rgba(255,255,255,0.5)',
    },
    storageFreeLabel: {
        fontSize: 14,
        color: 'rgba(255,255,255,0.4)',
    },
    storageUsedValue: {
        fontSize: 36,
        fontWeight: '800',
        paddingHorizontal: 20,
        marginTop: 2,
        marginBottom: 16,
    },
    storageBar: {
        flexDirection: 'row',
        height: 12,
        borderRadius: 6,
        overflow: 'hidden',
        marginHorizontal: 20,
        backgroundColor: 'rgba(255,255,255,0.05)',
    },
    storageSegment: {
        height: '100%',
    },
    storageLegend: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 14,
        paddingBottom: 18,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    legendDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
    legendLabel: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.5)',
    },

    // App Storage
    appStorageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        gap: 14,
    },
    appIconContainer: {
        width: 44,
        height: 44,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    appStorageTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#fff',
    },
    appStorageSubtitle: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.4)',
        marginTop: 2,
    },
    breakdownItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 13,
    },
    breakdownIcon: {
        width: 32,
        height: 32,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: 12,
    },
    breakdownLabel: {
        flex: 1,
        fontSize: 14,
        color: 'rgba(255,255,255,0.7)',
    },
    breakdownValue: {
        fontSize: 13,
        color: 'rgba(255,255,255,0.4)',
    },

    // Media Grid
    selectText: {
        fontSize: 15,
        fontWeight: '600',
        marginRight: 4,
    },
    mediaGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 4,
    },
    mediaGridItem: {
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'rgba(255,255,255,0.05)',
    },

    mediaThumbnail: {
        width: '100%',
        height: '100%',
    },
    mediaPlaceholder: {
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.04)',
    },
    mediaTypeLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: 'rgba(255,255,255,0.4)',
        marginTop: 6,
        letterSpacing: 0.5,
    },
    mediaTypeBadge: {
        position: 'absolute',
        bottom: 6,
        left: 6,
        backgroundColor: 'rgba(0,0,0,0.6)',
        borderRadius: 4,
        padding: 3,
    },
    selectionCheckbox: {
        position: 'absolute',
        top: 6,
        right: 6,
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: 'rgba(255,255,255,0.7)',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.3)',
    },
    deleteSelectedBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 14,
        paddingVertical: 14,
        borderRadius: 14,
    },
    deleteSelectedText: {
        color: 'white',
        fontSize: 15,
        fontWeight: '700',
    },
    moreItemsText: {
        textAlign: 'center',
        color: 'rgba(255,255,255,0.3)',
        fontSize: 13,
        marginTop: 10,
    },



    // Actions
    actionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        gap: 14,
    },
    actionIcon: {
        width: 40,
        height: 40,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actionTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: '#fff',
    },
    actionSubtitle: {
        fontSize: 12,
        color: 'rgba(255,255,255,0.4)',
        marginTop: 2,
    },

    // Empty States
    emptyState: {
        alignItems: 'center',
        paddingVertical: 40,
        gap: 12,
    },
    emptyText: {
        color: 'rgba(255,255,255,0.35)',
        fontSize: 14,
    },
    emptyChatStorage: {
        alignItems: 'center',
        paddingVertical: 30,
        gap: 10,
    },

    // Loading
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
    },
    loadingText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 14,
    },
});
