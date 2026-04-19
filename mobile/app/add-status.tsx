import React, { useState, useEffect } from 'react';
import {
    View, Text, Image, TextInput, Pressable, StyleSheet, useWindowDimensions,
    StatusBar, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Keyboard
} from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { 
    FadeIn, 
    SlideInDown, 
    Layout
} from 'react-native-reanimated';
import { Video, ResizeMode } from 'expo-av';
import { useApp } from '../context/AppContext';
import { statusService } from '../services/StatusService';
import { CropImageModal } from '../components/CropImageModal';

export default function AddStatusScreen() {
    const { width, height } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const { activeTheme } = useApp();
    
    const [media, setMedia] = useState<{ uri: string; type: 'image' | 'video' } | null>(null);
    const [caption, setCaption] = useState('');
    const [loading, setLoading] = useState(false);
    const [isCropModalVisible, setIsCropModalVisible] = useState(false);
    const [initialPickDone, setInitialPickDone] = useState(false);

    const handlePickMedia = async () => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images', 'videos'] as ImagePicker.MediaType[],
                allowsEditing: true,
                quality: 0.8,
                videoMaxDuration: 30,
            });

            if (!result.canceled && result.assets[0]) {
                const asset = result.assets[0];
                setMedia({
                    uri: asset.uri,
                    type: asset.type === 'video' ? 'video' : 'image',
                });
            } else if (!media) {
                router.back();
            }
        } catch (e) {
            router.back();
        }
    };

    useEffect(() => {
        if (!initialPickDone) {
            handlePickMedia();
            setInitialPickDone(true);
        }
    }, [initialPickDone]);

    const handlePost = async () => {
        if (!media) return;
        setLoading(true);
        try {
            await statusService.uploadStory(media.uri, media.type, caption.trim());
            router.replace('/(tabs)/status');
        } catch (e) {
            Alert.alert('Upload Error', 'Failed to share status. It will be retried in background.');
            router.replace('/(tabs)/status');
        } finally {
            setLoading(false);
        }
    };

    if (!media) {
        return (
            <View style={styles.blackCenter}>
                <ActivityIndicator color="#8C0016" size="large" />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <StatusBar hidden />

            {/* Preview Container with Padding to show rounded edges */}
            <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', padding: 8, paddingBottom: 100 }]}>
                {media.type === 'video' ? (
                    <Video 
                        source={{ uri: media.uri }}
                        style={styles.fullScreen}
                        resizeMode={ResizeMode.CONTAIN}
                        shouldPlay
                        isLooping
                    />
                ) : (
                    <Image source={{ uri: media.uri }} style={styles.fullScreen} resizeMode="contain" />
                )}
            </View>
            
            {/* Top Controls */}
            <LinearGradient colors={['rgba(0,0,0,0.7)', 'transparent']} style={styles.topGradient}>
                <View style={styles.topBar}>
                    <Pressable onPress={() => router.back()} style={styles.iconButton}>
                        <Ionicons name="close" size={28} color="white" />
                    </Pressable>
                    <View style={styles.topTools}>
                        <Pressable style={styles.iconButton} onPress={() => Alert.alert("Music", "Coming soon!")}>
                            <MaterialIcons name="music-note" size={24} color="white" />
                        </Pressable>
                        {media.type === 'image' && (
                            <Pressable style={styles.iconButton} onPress={() => setIsCropModalVisible(true)}>
                                <MaterialIcons name="crop" size={24} color="white" />
                            </Pressable>
                        )}
                        <Pressable style={styles.iconButton}>
                            <MaterialIcons name="text-fields" size={24} color="white" />
                        </Pressable>
                    </View>
                </View>
            </LinearGradient>

            {/* Bottom Controls */}
            <KeyboardAvoidingView 
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.bottomContainer}
            >
                <LinearGradient colors={['transparent', 'rgba(0,0,0,0.9)']} style={styles.bottomGradient} />
                
                <Animated.View 
                    entering={SlideInDown.springify()} 
                    style={styles.inputRow}
                >
                    <Pressable 
                        onPress={handlePickMedia}
                        style={styles.galleryButton}
                    >
                        <MaterialIcons name="image" size={24} color="white" />
                    </Pressable>

                    <View style={styles.inputWrapper}>
                        <TextInput
                            style={styles.captionInput}
                            placeholder="Add a caption..."
                            placeholderTextColor="rgba(255,255,255,0.6)"
                            value={caption}
                            onChangeText={setCaption}
                            multiline
                            maxLength={200}
                        />
                    </View>
                    
                    <Pressable 
                        onPress={handlePost}
                        disabled={loading}
                        style={[styles.sendButton, { backgroundColor: '#8C0016' }]}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <MaterialIcons name="send" size={24} color="white" />
                        )}
                    </Pressable>
                </Animated.View>
            </KeyboardAvoidingView>

            <CropImageModal
                visible={isCropModalVisible}
                imageUri={media.uri}
                onClose={() => setIsCropModalVisible(false)}
                onCropComplete={(uri) => setMedia({ ...media, uri })}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    blackCenter: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
    fullScreen: { width: '100%', height: '100%', borderRadius: 24, overflow: 'hidden' },
    topGradient: { position: 'absolute', top: 0, left: 0, right: 0, height: 120 },
    topBar: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 50, paddingHorizontal: 20 },
    topTools: { flexDirection: 'row', gap: 15 },
    iconButton: { padding: 8, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 20 },
    bottomContainer: { position: 'absolute', bottom: 0, width: '100%' },
    bottomGradient: { position: 'absolute', bottom: 0, width: '100%', height: 200 },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 20, paddingBottom: 40, gap: 8 },
    inputWrapper: { flex: 1, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 25, minHeight: 50, paddingHorizontal: 20, justifyContent: 'center' },
    captionInput: { color: 'white', fontSize: 16, paddingVertical: 10 },
    galleryButton: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(255,255,255,0.15)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    sendButton: { width: 50, height: 50, borderRadius: 25, justifyContent: 'center', alignItems: 'center' }
});
