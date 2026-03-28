import React, { useState, useRef, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { formatDuration } from '../../utils/formatters';

interface VoiceNotePlayerProps {
    uri: string;
    isMe: boolean;
    theme: any;
    initialDuration?: number;
}


const VoiceNotePlayer = ({ uri, isMe, theme, initialDuration }: VoiceNotePlayerProps) => {
    const soundRef = useRef<Audio.Sound | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(initialDuration || 0);

    // Update duration if prop changes
    useEffect(() => {
        if (initialDuration && initialDuration > 0) {
            setDuration(initialDuration);
        }
    }, [initialDuration]);

    const onPlaybackStatusUpdate = (status: any) => {
        if (status.isLoaded) {
            setPosition(status.positionMillis);
            setDuration(status.durationMillis || 0);
            if (status.didJustFinish) {
                setIsPlaying(false);
                setPosition(0);
                soundRef.current?.setPositionAsync(0);
            }
        }
    };

    const togglePlayPause = async () => {
        try {
            if (!soundRef.current) {
                const { sound } = await Audio.Sound.createAsync(
                    { uri },
                    { shouldPlay: true },
                    onPlaybackStatusUpdate
                );
                soundRef.current = sound;
                setIsPlaying(true);
            } else {
                if (isPlaying) {
                    await soundRef.current.pauseAsync();
                    setIsPlaying(false);
                } else {
                    await soundRef.current.playAsync();
                    setIsPlaying(true);
                }
            }
        } catch (err) {
            console.error('Playback failed', err);
        }
    };

    useEffect(() => {
        return () => {
            if (soundRef.current) {
                soundRef.current.unloadAsync();
            }
        };
    }, []);

    const progress = duration > 0 ? position / duration : 0;

    return (
        <View style={styles.voiceNoteContainer}>
            <Pressable onPress={togglePlayPause} style={[styles.vnPlayButton, { backgroundColor: isMe ? 'rgba(255,255,255,0.2)' : theme.primary }]}>
                <MaterialIcons name={isPlaying ? 'pause' : 'play-arrow'} size={24} color="white" />
            </Pressable>
            <View style={styles.vnProgressWrapper}>
                <View style={[styles.vnProgressBackground, { backgroundColor: isMe ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)' }]} />
                <View style={[styles.vnProgressBar, { width: `${progress * 100}%`, backgroundColor: isMe ? '#fff' : theme.primary }]} />
            </View>
            <Text style={styles.vnDuration}>{formatDuration(Math.floor((duration || 0) / 1000))}</Text>
        </View>
    );
};

export default VoiceNotePlayer;

const styles = StyleSheet.create({
    voiceNoteContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 4,
        minWidth: 180,
        gap: 12,
    },
    vnPlayButton: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
    },
    vnProgressWrapper: {
        flex: 1,
        height: 4,
        position: 'relative',
        justifyContent: 'center',
    },
    vnProgressBackground: {
        position: 'absolute',
        left: 0,
        right: 0,
        height: 4,
        borderRadius: 2,
    },
    vnProgressBar: {
        height: 4,
        borderRadius: 2,
        zIndex: 1,
    },
    vnDuration: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 11,
        width: 32,
        textAlign: 'right',
        fontWeight: '600',
    },
});
