import React, { useState, useEffect, useRef } from 'react';
import { 
    View, Text, StyleSheet, Modal, Pressable, TextInput, 
    Image, KeyboardAvoidingView, Platform, Keyboard, useWindowDimensions,
} from 'react-native';
import GlassView from './ui/GlassView';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn, SlideInDown, useAnimatedStyle, withSpring, useSharedValue } from 'react-native-reanimated';
import { useApp } from '../context/AppContext';


interface NoteCreatorModalProps {
    visible: boolean;
    onClose: () => void;
    onSave?: (note: string) => void; // Added onSave to interface
}

export const NoteCreatorModal = ({ visible, onClose, onSave }: NoteCreatorModalProps) => {
    const { width, height } = useWindowDimensions();
    const { currentUser, updateNote, activeTheme } = useApp();
    const [noteText, setNoteText] = useState(currentUser?.note || '');
    const [prevVisible, setPrevVisible] = useState(visible);

    if (visible !== prevVisible) {
        if (visible) {
            setNoteText(currentUser?.note || '');
        }
        setPrevVisible(visible);
    }
    const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
    const inputRef = useRef<TextInput>(null);

    useEffect(() => {
        if (visible) {
            const timer = setTimeout(() => inputRef.current?.focus(), 500);
            return () => clearTimeout(timer);
        }
    }, [visible]);

    useEffect(() => {
        const showSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setIsKeyboardVisible(true));
        const hideSub = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setIsKeyboardVisible(false));
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    const handleDone = () => {
        if (noteText.trim()) {
            updateNote(noteText.trim());
        }
        onClose();
    };

    const handleDelete = () => {
        updateNote(null);
        setNoteText('');
        onClose();
    };

    if (!visible) return null;

    return (
        <Modal
            transparent
            visible={visible}
            animationType="fade"
            onRequestClose={onClose}
        >
            <View style={styles.container}>
                <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                
                <KeyboardAvoidingView 
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.keyboardView}
                >
                    {/* Header */}
                    <View style={styles.header}>
                        <Pressable onPress={onClose} style={styles.headerButton}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </Pressable>
                        <Pressable onPress={handleDone} style={[styles.doneButton, { backgroundColor: activeTheme.primary }]}>
                            <Text style={styles.doneText}>Done</Text>
                        </Pressable>
                    </View>

                    {/* Content */}
                    <View style={styles.content}>
                        <View style={styles.avatarWrapper}>
                            {/* Note Bubble Preview */}
                            <Animated.View 
                                entering={FadeIn.delay(300)}
                                style={[styles.previewBubble, { width: width * 0.7 }]}
                            >
                                <TextInput
                                    ref={inputRef}
                                    style={styles.input}
                                    placeholder="What&apos;s on your mind?"
                                    placeholderTextColor="rgba(255,255,255,0.4)"
                                    value={noteText}
                                    onChangeText={setNoteText}
                                    multiline
                                    maxLength={60}
                                    selectionColor={activeTheme.primary}
                                />
                                {/* Tail dots for consistency */}
                                <View style={styles.tailAnchor}>
                                    <View style={[styles.tailRoot, { backgroundColor: '#262626' }]} />
                                    <View style={[styles.tailMain, { backgroundColor: '#262626' }]} />
                                    <View style={[styles.tailDotSmall, { backgroundColor: '#262626' }]} />
                                </View>
                            </Animated.View>

                            <Image 
                                source={{ uri: currentUser?.avatar || 'https://via.placeholder.com/150' }} 
                                style={styles.avatar} 
                            />
                        </View>

                        <Text style={styles.hintText}>
                            Shared for 24 hours. People won&apos;t be notified when you share a note.
                        </Text>
                    </View>

                    {/* Actions if existing note */}
                    {currentUser?.note && (
                        <Animated.View 
                            entering={SlideInDown.springify()}
                            style={styles.actionsFooter}
                        >
                            <Pressable 
                                onPress={() => setNoteText('')}
                                style={styles.actionBtn}
                            >
                                <Text style={styles.actionBtnText}>Leave a new note</Text>
                            </Pressable>
                            <Pressable 
                                onPress={handleDelete}
                                style={[styles.actionBtn, styles.deleteBtn]}
                            >
                                <Text style={[styles.actionBtnText, { color: '#ef4444' }]}>Delete note</Text>
                            </Pressable>
                        </Animated.View>
                    )}
                </KeyboardAvoidingView>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
    },
    keyboardView: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingTop: Platform.OS === 'ios' ? 60 : 40,
    },
    headerButton: {
        padding: 8,
    },
    cancelText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '500',
    },
    doneButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
    },
    doneText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    content: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 100,
    },
    avatarWrapper: {
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
    },
    avatar: {
        width: 120,
        height: 120,
        borderRadius: 60,
        borderWidth: 4,
        borderColor: '#1a1a1a',
    },
    notePreview: {
        height: 120,
        borderRadius: 12,
        marginBottom: 24,
        overflow: 'hidden',
    },
    previewBubble: {
        backgroundColor: '#262626',
        paddingVertical: 28,
        paddingHorizontal: 32,
        borderRadius: 38,
        marginBottom: 20,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center',
        position: 'relative',
        minWidth: 210,
    },
    input: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '700',
        textAlign: 'center',
        width: '100%',
    },
    tailAnchor: {
        position: 'absolute',
        top: '100%',
        left: 40,
        width: 80,
        height: 60,
    },
    tailRoot: {
        position: 'absolute',
        top: 2,
        left: 0,
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 1.5,
        borderColor: 'rgba(255,255,255,0.12)',
    },
    tailMain: {
        position: 'absolute',
        top: 28,
        left: 10,
        width: 9,
        height: 9,
        borderRadius: 4.5,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
    },
    tailDotSmall: {
        position: 'absolute',
        top: 48,
        left: 20,
        width: 5,
        height: 5,
        borderRadius: 2.5,
        opacity: 0.6,
        backgroundColor: '#fff', // Slightly different for modal preview
    },
    hintText: {
        color: 'rgba(255,255,255,0.4)',
        fontSize: 13,
        textAlign: 'center',
        paddingHorizontal: 40,
    },
    actionsFooter: {
        paddingHorizontal: 20,
        paddingBottom: 40,
        gap: 12,
    },
    actionBtn: {
        backgroundColor: 'rgba(255,255,255,0.05)',
        paddingVertical: 16,
        borderRadius: 16,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    deleteBtn: {
        // backgroundColor: 'rgba(239, 68, 68, 0.1)',
    },
    actionBtnText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
});
