import React, { useState, useRef } from 'react';
import { 
    View, 
    Text, 
    StyleSheet, 
    TextInput, 
    Pressable, 
    KeyboardAvoidingView, 
    Platform,
    StatusBar,
    Alert
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { statusService } from '../services/StatusService';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

const BG_COLORS = [
    '#8C0016', // Soul Red
    '#4a148c', // Purple
    '#01579b', // Blue
    '#004d40', // Teal
    '#bf360c', // Orange
    '#1b5e20', // Green
    '#000000', // Black
];

export default function SoulNoteScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const [text, setText] = useState('');
    const [bgColorIdx, setBgColorIdx] = useState(0);
    const [loading, setLoading] = useState(false);
    const inputRef = useRef<TextInput>(null);

    const handleSave = async () => {
        if (!text.trim()) return;
        setLoading(true);
        try {
            await statusService.updateSoulNote(text.trim());
            router.back();
        } catch (e) {
            Alert.alert('Error', 'Failed to update Soul Note');
        } finally {
            setLoading(false);
        }
    };

    const nextBg = () => {
        setBgColorIdx((prev) => (prev + 1) % BG_COLORS.length);
    };

    return (
        <View style={[styles.container, { backgroundColor: BG_COLORS[bgColorIdx] }]}>
            <StatusBar barStyle="light-content" />
            
            <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
                <Pressable onPress={() => router.back()} style={styles.iconButton}>
                    <Ionicons name="close" size={28} color="#fff" />
                </Pressable>
                
                <View style={styles.headerRight}>
                    <Pressable onPress={nextBg} style={styles.iconButton}>
                        <Ionicons name="color-palette-outline" size={24} color="#fff" />
                    </Pressable>
                    <Pressable 
                        onPress={handleSave} 
                        disabled={!text.trim() || loading}
                        style={[styles.saveButton, !text.trim() && { opacity: 0.5 }]}
                    >
                        <Text style={styles.saveText}>{loading ? '...' : 'Done'}</Text>
                    </Pressable>
                </View>
            </View>

            <KeyboardAvoidingView 
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.content}
            >
                <TextInput
                    ref={inputRef}
                    style={styles.input}
                    placeholder="Type a Soul Note..."
                    placeholderTextColor="rgba(255,255,255,0.5)"
                    multiline
                    maxLength={140}
                    autoFocus
                    value={text}
                    onChangeText={setText}
                    selectionColor="#fff"
                />
                
                <Text style={styles.counter}>{text.length}/140</Text>
            </KeyboardAvoidingView>

            <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
                 <Text style={styles.footerHint}>This note will appear above your avatar for 24h</Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    iconButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0,0,0,0.15)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButton: {
        paddingHorizontal: 20,
        height: 38,
        borderRadius: 19,
        backgroundColor: '#fff',
        justifyContent: 'center',
        alignItems: 'center',
        marginLeft: 12,
    },
    saveText: {
        color: '#000',
        fontWeight: '700',
        fontSize: 15,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 30,
    },
    input: {
        fontSize: 32,
        fontWeight: '700',
        color: '#fff',
        textAlign: 'center',
        width: '100%',
    },
    counter: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
        marginTop: 20,
        fontWeight: '600',
    },
    footer: {
        alignItems: 'center',
    },
    footerHint: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 13,
        fontWeight: '500',
    }
});
