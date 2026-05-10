import React, { useMemo } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    StyleProp,
    ViewStyle,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
} from 'react-native-reanimated';
import GlassView from '../ui/GlassView';
import { useApp } from '../../context/AppContext';
import { SoulAvatar } from '../SoulAvatar';
import type { TheaterRoomParticipant } from '../../services/TheaterRoomService';
import type { TheaterViewer } from '../../services/TheaterSyncService';

interface ParticipantRow {
    userId: string;
    name: string;
    avatar?: string;
    localAvatar?: string;
    avatarType?: any;
    teddyVariant?: any;
    isMe: boolean;
    isHost: boolean;
    micOn: boolean;
    cameraOn: boolean;
    inRoom: boolean;
}

interface TheaterParticipantsOverlayProps {
    accent: string;
    hostId?: string;
    /** WebRTC mesh peers — used for cam/mic state when present. */
    participants: Map<string, TheaterRoomParticipant>;
    /** Source of truth for who's actually in the room (presence-tracked). */
    viewers: TheaterViewer[];
    micEnabled: boolean;
    cameraEnabled: boolean;
    onClose: () => void;
    bottomInset?: number;
    style?: StyleProp<ViewStyle>;
}

const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r},${g},${b},${alpha})`;
};

const TheaterParticipantsOverlay: React.FC<TheaterParticipantsOverlayProps> = ({
    accent,
    hostId,
    participants,
    viewers,
    micEnabled,
    cameraEnabled,
    onClose,
    bottomInset = 0,
    style,
}) => {
    const { contacts, currentUser } = useApp() as any;

    const rows: ParticipantRow[] = useMemo(() => {
        const myId = currentUser?.id || '';

        // Build the row list off of presence (the real "who's in the room"
        // source) and decorate each with WebRTC cam/mic state when we have
        // it. Falls back to the local user if presence hasn't synced yet so
        // the modal is never empty.
        const seen = new Set<string>();
        const ordered: TheaterViewer[] = [];

        // Local user first
        if (myId) {
            ordered.push({ userId: myId, joinedAt: 0 });
            seen.add(myId);
        }
        // Host second (if not me and not yet added)
        if (hostId && !seen.has(hostId)) {
            ordered.push({ userId: hostId, joinedAt: 0 });
            seen.add(hostId);
        }
        // Then everyone else by join time
        [...viewers]
            .sort((a, b) => a.joinedAt - b.joinedAt)
            .forEach((v) => {
                if (!seen.has(v.userId)) {
                    ordered.push(v);
                    seen.add(v.userId);
                }
            });

        return ordered.map<ParticipantRow>((v) => {
            const isMe = v.userId === myId;
            const peer = participants.get(v.userId);
            const c = isMe ? null : (contacts || []).find((x: any) => x.id === v.userId);
            return {
                userId: v.userId,
                name: isMe ? 'You' : (c?.name || c?.username || 'Guest'),
                avatar: isMe ? (currentUser?.avatarUrl || currentUser?.avatar) : c?.avatar,
                localAvatar: isMe ? currentUser?.localAvatarUri : c?.localAvatarUri,
                avatarType: isMe ? currentUser?.avatarType : c?.avatarType,
                teddyVariant: isMe ? currentUser?.teddyVariant : c?.teddyVariant,
                isMe,
                isHost: !!hostId && hostId === v.userId,
                micOn: isMe ? micEnabled : !!peer?.hasAudio,
                cameraOn: isMe ? cameraEnabled : !!peer?.hasVideo,
                inRoom: true,
            };
        });
    }, [contacts, currentUser, participants, viewers, hostId, micEnabled, cameraEnabled]);

    const renderItem = ({ item }: { item: ParticipantRow }) => (
        <View style={styles.row}>
            <SoulAvatar
                uri={item.avatar}
                localUri={item.localAvatar}
                size={40}
                avatarType={item.avatarType}
                teddyVariant={item.teddyVariant}
            />
            <View style={styles.nameWrap}>
                <View style={styles.nameRow}>
                    <Text style={styles.name} numberOfLines={1}>
                        {item.name}
                    </Text>
                    {item.isHost && (
                        <View style={[styles.hostChip, { backgroundColor: hexToRgba(accent, 0.2), borderColor: hexToRgba(accent, 0.45) }]}>
                            <MaterialIcons name="star" size={10} color={accent} />
                            <Text style={[styles.hostChipText, { color: accent }]}>HOST</Text>
                        </View>
                    )}
                </View>
                <Text style={styles.subtle}>
                    {item.inRoom ? (item.isMe ? 'You' : 'In room') : 'Watching'}
                </Text>
            </View>
            <View style={styles.statusRow}>
                <View style={[
                    styles.statusChip,
                    { backgroundColor: item.micOn ? hexToRgba(accent, 0.85) : 'rgba(255,255,255,0.08)' },
                ]}>
                    <MaterialIcons
                        name={item.micOn ? 'mic' : 'mic-off'}
                        size={13}
                        color={item.micOn ? '#fff' : 'rgba(255,255,255,0.55)'}
                    />
                </View>
                <View style={[
                    styles.statusChip,
                    { backgroundColor: item.cameraOn ? hexToRgba(accent, 0.85) : 'rgba(255,255,255,0.08)' },
                ]}>
                    <MaterialIcons
                        name={item.cameraOn ? 'videocam' : 'videocam-off'}
                        size={13}
                        color={item.cameraOn ? '#fff' : 'rgba(255,255,255,0.55)'}
                    />
                </View>
            </View>
        </View>
    );

    return (
        <Animated.View
            entering={SlideInDown.duration(220)}
            exiting={SlideOutDown.duration(180)}
            style={[styles.root, style]}
        >
            <Pressable style={styles.backdrop} onPress={onClose}>
                <Animated.View
                    entering={FadeIn.duration(160)}
                    exiting={FadeOut.duration(140)}
                    style={StyleSheet.absoluteFill}
                />
            </Pressable>

            <View style={[styles.sheet, { paddingBottom: bottomInset + 8 }]}>
                <GlassView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />

                <View style={styles.header}>
                    <View style={styles.handle} />
                    <View style={styles.headerRow}>
                        <View style={styles.titleWrap}>
                            <MaterialIcons name="people-alt" size={15} color={accent} />
                            <Text style={styles.title}>Participants</Text>
                            <View style={styles.countChip}>
                                <Text style={styles.countText}>{rows.length}</Text>
                            </View>
                        </View>
                        <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
                            <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.7)" />
                        </Pressable>
                    </View>
                </View>

                <FlashList
                    data={rows}
                    keyExtractor={(p) => p.userId || p.name}
                    estimatedItemSize={64}
                    renderItem={renderItem}
                    contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12 }}
                    showsVerticalScrollIndicator={false}
                />
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    root: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'flex-end',
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.18)',
    },
    sheet: {
        height: '52%',
        borderTopLeftRadius: 22,
        borderTopRightRadius: 22,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.5)',
    },
    header: {
        paddingTop: 6,
        paddingHorizontal: 14,
        paddingBottom: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255,255,255,0.08)',
    },
    handle: {
        alignSelf: 'center',
        width: 36,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.22)',
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
    },
    titleWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    countChip: {
        marginLeft: 4,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 9,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    countText: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 10,
        fontWeight: '700',
    },
    closeBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
        paddingHorizontal: 6,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(255,255,255,0.06)',
    },
    nameWrap: {
        flex: 1,
        minWidth: 0,
    },
    nameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    name: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '700',
        letterSpacing: 0.1,
        flexShrink: 1,
    },
    hostChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 8,
        borderWidth: 1,
    },
    hostChipText: {
        fontSize: 9,
        fontWeight: '800',
        letterSpacing: 0.6,
    },
    subtle: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 11.5,
        fontWeight: '500',
        marginTop: 2,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    statusChip: {
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default TheaterParticipantsOverlay;
