import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, Platform } from 'react-native';
import { BlurView } from 'expo-blur';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { 
    useSharedValue, 
    useAnimatedStyle, 
    withSpring, 
    withTiming, 
    interpolate, 
    Easing, 
    runOnJS 
} from 'react-native-reanimated';
import { SCREEN_WIDTH, SCREEN_HEIGHT, ChatStyles } from './ChatStyles';

interface ChatListContextMenuProps {
    visible: boolean;
    chatItem: any; // The contact/chat item
    layout: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    onClose: () => void;
    onAction: (action: string) => void;
    isPinned: boolean;
    isMuted: boolean;
    renderItem: () => React.ReactNode; // Function to render the highlighted item
}

const ChatListContextMenu = ({ 
    visible, 
    chatItem, 
    layout, 
    onClose, 
    onAction, 
    isPinned, 
    isMuted,
    renderItem
}: ChatListContextMenuProps) => {
    const progress = useSharedValue(0);

    useEffect(() => {
        if (visible && layout) {
            progress.value = 0;
            progress.value = withSpring(1, {
                damping: 20,
                stiffness: 250,
                mass: 1,
            });
        }
    }, [visible, layout, progress]);

    const handleClose = () => {
        progress.value = withTiming(0, {
            duration: 150,
            easing: Easing.out(Easing.quad)
        }, (finished) => {
            if (finished && onClose) {
                runOnJS(onClose)();
            }
        });
    };

    const containerStyle = useAnimatedStyle(() => {
        return {
            opacity: progress.value,
            transform: [
                { scale: interpolate(progress.value, [0, 1], [0.95, 1]) }
            ]
        };
    });

    const backdropStyle = useAnimatedStyle(() => {
        return {
            opacity: progress.value
        };
    });

    if (!visible || !chatItem || !layout) return null;

    const ACTION_ITEM_HEIGHT = 50;
    // Pin, Mute, Select, Archive, Delete, Cancel — must match the actual
    // Pressables rendered below or the menu overflows hidden and the
    // "place above" overflow check uses the wrong height.
    const numberOfActions = 6;
    const ACTION_MENU_HEIGHT = numberOfActions * ACTION_ITEM_HEIGHT;
    const GAP = 12;

    const safeTop = 60;
    const safeBottom = SCREEN_HEIGHT - 60;

    let unitY = layout.y;
    let menuY = layout.y + layout.height + GAP;

    // Adjust if menu goes off screen
    if (menuY + ACTION_MENU_HEIGHT > safeBottom) {
        // Try placing menu above the item
        menuY = layout.y - ACTION_MENU_HEIGHT - GAP;
        
        // If it still goes off the top, we need more complex adjustment
        if (menuY < safeTop) {
            menuY = safeTop;
            unitY = menuY + ACTION_MENU_HEIGHT + GAP;
        }
    }

    return (
        <View style={[StyleSheet.absoluteFill, { zIndex: 9999, elevation: 9999 }]}>
            <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
                <BlurView intensity={80} tint="dark" experimentalBlurMethod="dimezisBlurView" style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0, 0, 0, 0.45)' }]} pointerEvents="none" />
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
            </Animated.View>

            <Animated.View style={[StyleSheet.absoluteFill, containerStyle]} pointerEvents="box-none">
                {/* 1. Highlighted Item Clone */}
                <View style={{
                    position: 'absolute',
                    top: unitY,
                    left: layout.x,
                    width: layout.width,
                    height: layout.height,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 10 },
                    shadowOpacity: 0.3,
                    shadowRadius: 15,
                    elevation: 10,
                }}>
                    {renderItem()}
                </View>

                {/* 2. Action Menu */}
                <View style={{
                    position: 'absolute',
                    top: menuY,
                    right: layout.x, // Align to right edge of the chat pill
                    width: 220,
                    height: ACTION_MENU_HEIGHT,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 10 },
                    shadowOpacity: 0.5,
                    shadowRadius: 15,
                    elevation: 10,
                }}>
                    <BlurView 
                        intensity={60} 
                        tint="dark" 
                        experimentalBlurMethod="dimezisBlurView" 
                        style={{ 
                            borderRadius: 24, 
                            overflow: 'hidden', 
                            borderWidth: 1, 
                            borderColor: 'rgba(255,255,255,0.08)', 
                            backgroundColor: 'rgba(30,30,30,0.4)',
                            height: '100%' 
                        }} 
                    >
                        <View style={{ flex: 1 }}>
                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('pin'); handleClose(); }}>
                                <MaterialIcons name={isPinned ? "push-pin" : "push-pin"} size={22} color={isPinned ? "#3b82f6" : "#fff"} />
                                <Text style={[ChatStyles.contextActionText, isPinned && { color: '#3b82f6' }]}>
                                    {isPinned ? 'Unpin' : 'Pin to top'}
                                </Text>
                            </Pressable>
                            
                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('mute'); handleClose(); }}>
                                <MaterialIcons name={isMuted ? "notifications-active" : "notifications-off"} size={22} color="#fff" />
                                <Text style={ChatStyles.contextActionText}>
                                    {isMuted ? 'Unmute' : 'Mute'}
                                </Text>
                            </Pressable>

                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('select'); handleClose(); }}>
                                <MaterialIcons name="check-circle-outline" size={22} color="#fff" />
                                <Text style={ChatStyles.contextActionText}>Select</Text>
                            </Pressable>

                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('archive'); handleClose(); }}>
                                <MaterialIcons name="archive" size={22} color="#ff4444" />
                                <Text style={[ChatStyles.contextActionText, { color: '#ff4444' }]}>Archive</Text>
                            </Pressable>

                            <Pressable style={ChatStyles.contextActionBtn} onPress={() => { onAction('delete'); handleClose(); }}>
                                <MaterialIcons name="delete-outline" size={22} color="#ff4444" />
                                <Text style={[ChatStyles.contextActionText, { color: '#ff4444' }]}>
                                    {chatItem?.isGroup ? 'Exit / Delete Group' : 'Delete Chat'}
                                </Text>
                            </Pressable>

                            <Pressable style={[ChatStyles.contextActionBtn, { borderBottomWidth: 0 }]} onPress={handleClose}>
                                <MaterialIcons name="close" size={22} color="rgba(255,255,255,0.5)" />
                                <Text style={[ChatStyles.contextActionText, { color: 'rgba(255,255,255,0.5)' }]}>Cancel</Text>
                            </Pressable>
                        </View>
                    </BlurView>
                </View>
            </Animated.View>
        </View>
    );
};

export default ChatListContextMenu;
