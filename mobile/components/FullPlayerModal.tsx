import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Image, Modal, useWindowDimensions, Alert, Platform, Vibration, Share, Linking } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';

const MARGIN_BOTTOM = Platform.OS === 'ios' ? 44 : 24;

interface FullPlayerModalProps {
    visible: boolean;
    onClose: () => void;
    onBack?: () => void;
}

const FullPlayerModal: React.FC<FullPlayerModalProps> = ({ visible, onClose }) => {
    const { width } = useWindowDimensions();
    const { musicState, togglePlayMusic, toggleFavoriteSong, seekTo, getPlaybackPosition } = useApp();
    const song = musicState.currentSong;
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);

    useEffect(() => {
        let interval: any;
        if (visible && musicState.isPlaying) {
            interval = setInterval(async () => {
                const pos = await getPlaybackPosition();
                setPosition(pos);
                setDuration(song?.duration ? song.duration * 1000 : 240000);
            }, 1000);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [visible, musicState.isPlaying, song]);

    if (!song) return null;

    const formatTime = (ms: number) => {
        const totalSeconds = Math.floor(ms / 1000);
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const isFav = musicState.favorites.some(s => s.id === song.id);

    return (
        <Modal visible={visible} animationType="slide" transparent>
            <BlurView intensity={Platform.OS === 'android' ? 150 : 100} tint="dark" style={styles.fullPlayerContainer} experimentalBlurMethod="dimezisBlurView">
                <View style={styles.fullPlayerHeader}>
                    <Pressable onPress={onClose} style={styles.chevronDown}>
                        <MaterialIcons name="keyboard-arrow-down" size={32} color="#fff" />
                    </Pressable>
                    <Text style={styles.headerTitle}>NOW PLAYING</Text>
                    <View style={styles.moreOptions}>
                        <MaterialIcons name="more-vert" size={24} color="#fff" />
                    </View>
                </View>

                <View style={styles.fullPlayerContent}>
                    <Image source={{ uri: song.image }} style={[styles.fullPlayerArt, { width: width - 60, height: width - 60 }]} />

                    <View style={styles.fullPlayerInfo}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.fullPlayerTitle} numberOfLines={1}>{song.name}</Text>
                            <Text style={styles.fullPlayerArtist} numberOfLines={1}>{song.artist}</Text>
                        </View>
                        <Pressable onPress={() => toggleFavoriteSong(song)}>
                            <MaterialIcons name={isFav ? "favorite" : "favorite-border"} size={28} color={isFav ? "#f43f5e" : "#fff"} />
                        </Pressable>
                    </View>

                    <View style={styles.progressContainer}>
                        <View style={styles.progressBarBg}>
                            <View style={[styles.progressBarFill, { width: `${duration > 0 ? (position / duration) * 100 : 0}%` }]} />
                        </View>
                        <View style={styles.timeLabels}>
                            <Text style={styles.timeText}>{formatTime(position)}</Text>
                            <Text style={styles.timeText}>{formatTime(duration)}</Text>
                        </View>
                    </View>

                    <View style={styles.controlsContainer}>
                        <Pressable><MaterialIcons name="shuffle" size={24} color="rgba(255,255,255,0.5)" /></Pressable>
                        <Pressable><MaterialIcons name="skip-previous" size={40} color="#fff" /></Pressable>
                        <Pressable onPress={togglePlayMusic} style={styles.playPauseCircle}>
                            <MaterialIcons name={musicState.isPlaying ? "pause" : "play-arrow"} size={40} color="#000" />
                        </Pressable>
                        <Pressable><MaterialIcons name="skip-next" size={40} color="#fff" /></Pressable>
                        <Pressable><MaterialIcons name="repeat" size={24} color="rgba(255,255,255,0.5)" /></Pressable>
                    </View>
                </View>
            </BlurView>
        </Modal>
    );
};

const styles = StyleSheet.create({
    fullPlayerContainer: {
        flex: 1,
        paddingTop: 60,
        // Android: translucent backing lets dimezis blur show through; iOS uses native material
        ...(Platform.OS === 'android' && { backgroundColor: 'rgba(10, 10, 12, 0.4)' }),
    },
    fullPlayerHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        marginBottom: 40,
    },
    chevronDown: {
        padding: 5,
    },
    headerTitle: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '900',
        letterSpacing: 2,
    },
    moreOptions: {
        padding: 5,
    },
    fullPlayerContent: {
        flex: 1,
        alignItems: 'center',
        paddingHorizontal: 30,
    },
    fullPlayerArt: {
        borderRadius: 20,
        marginBottom: 40,
    },
    fullPlayerInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        marginBottom: 30,
    },
    fullPlayerTitle: {
        color: '#fff',
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 5,
    },
    fullPlayerArtist: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 18,
    },
    progressContainer: {
        width: '100%',
        marginBottom: 40,
    },
    progressBarBg: {
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 2,
        marginBottom: 10,
    },
    progressBarFill: {
        height: '100%',
        backgroundColor: '#fff',
        borderRadius: 2,
    },
    timeLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    timeText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 12,
    },
    controlsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
    },
    playPauseCircle: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: '#fff',
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default FullPlayerModal;
