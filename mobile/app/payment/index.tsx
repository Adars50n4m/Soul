import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    Linking,
    Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
    useSharedValue,
    useAnimatedStyle,
    withSpring,
    withTiming,
    Easing,
} from 'react-native-reanimated';
import GlassView from '../../components/ui/GlassView';
import { useApp } from '../../context/AppContext';

const PAY_SHARED_TAG = 'soul-pay-pill';

const safeEvalExpression = (expr: string): number | null => {
    const trimmed = expr.replace(/\s/g, '');
    if (!trimmed) return null;
    if (!/^[\d+\-*/.()]+$/.test(trimmed)) return null;
    if (/[+\-*/.]$/.test(trimmed)) return null;
    try {
        // eslint-disable-next-line no-new-func
        const result = new Function(`"use strict"; return (${trimmed})`)();
        if (typeof result !== 'number' || isNaN(result) || !isFinite(result)) return null;
        return Math.round(result * 100) / 100;
    } catch {
        return null;
    }
};

const OPERATOR_MAP: Record<string, string> = {
    '÷': '/',
    '×': '*',
    '−': '-',
    '+': '+',
};

const KEYPAD: string[][] = [
    ['7', '8', '9', '÷'],
    ['4', '5', '6', '×'],
    ['1', '2', '3', '−'],
    ['.', '0', '⌫', '+'],
];

type KeyProps = {
    label: string;
    accent: string;
    onPress: () => void;
};

const Key: React.FC<KeyProps> = React.memo(({ label, accent, onPress }) => {
    const pressed = useSharedValue(0);
    const isOp = label in OPERATOR_MAP;
    const isBack = label === '⌫';

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: 1 - pressed.value * 0.05 }],
        opacity: 1 - pressed.value * 0.25,
    }));

    return (
        <Pressable
            style={styles.keyTouchable}
            onPressIn={() => {
                pressed.value = withTiming(1, { duration: 80, easing: Easing.out(Easing.quad) });
            }}
            onPressOut={() => {
                pressed.value = withTiming(0, { duration: 140, easing: Easing.out(Easing.quad) });
            }}
            onPress={onPress}
        >
            <Animated.View style={[styles.key, isOp && styles.keyOp, animatedStyle]}>
                {isBack ? (
                    <MaterialIcons name="backspace" size={20} color="#fff" />
                ) : (
                    <Text style={[styles.keyText, isOp && { color: accent }]}>{label}</Text>
                )}
            </Animated.View>
        </Pressable>
    );
});
Key.displayName = 'Key';

export default function PaymentScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { activeTheme } = useApp() as any;
    const accent = activeTheme?.primary || '#ff0080';

    const [visible, setVisible] = useState(true);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [expression, setExpression] = useState('');
    const [upiId, setUpiId] = useState('');
    const [recipientName, setRecipientName] = useState('');

    const hasOperator = useMemo(() => /[÷×−+]/.test(expression), [expression]);

    const evaluated = useMemo(() => {
        if (!expression) return 0;
        if (/^\d+(\.\d+)?$/.test(expression)) return parseFloat(expression);
        const internal = expression.replace(/[÷×−]/g, (c) => OPERATOR_MAP[c] || c);
        return safeEvalExpression(internal) ?? 0;
    }, [expression]);

    const handleClose = useCallback(() => {
        if (closeTimerRef.current) return;
        setVisible(false);
        closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            if (router.canGoBack()) router.back();
            else router.replace('/' as any);
        }, 280);
    }, [router]);

    useEffect(() => {
        return () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        };
    }, []);

    const handleKey = useCallback((key: string) => {
        setExpression((prev) => {
            if (key === '⌫') return prev.slice(0, -1);
            if (key === '.') {
                const lastNumber = prev.split(/[÷×−+]/).pop() || '';
                if (lastNumber.includes('.')) return prev;
                if (!lastNumber) return prev + '0.';
                return prev + key;
            }
            if (key in OPERATOR_MAP) {
                if (!prev) return prev;
                const last = prev.slice(-1);
                if (last in OPERATOR_MAP) return prev.slice(0, -1) + key;
                if (last === '.') return prev;
                return prev + key;
            }
            // digit
            if (prev === '0') return key;
            return prev + key;
        });
    }, []);

    const handleSend = useCallback(async () => {
        if (evaluated <= 0) {
            Alert.alert('Amount', 'Enter a valid amount.');
            return;
        }
        const trimmedUpi = upiId.trim();
        if (!trimmedUpi || !trimmedUpi.includes('@')) {
            Alert.alert('UPI ID', 'Enter a valid UPI ID (e.g. name@okhdfcbank).');
            return;
        }
        const params = new URLSearchParams({
            pa: trimmedUpi,
            pn: recipientName.trim() || 'Recipient',
            am: evaluated.toFixed(2),
            cu: 'INR',
            tn: 'Paid via Soul',
        });
        const url = `upi://pay?${params.toString()}`;
        try {
            const supported = await Linking.canOpenURL(url);
            if (!supported) {
                Alert.alert('No UPI app', 'No UPI-capable app found on this device.');
                return;
            }
            await Linking.openURL(url);
            handleClose();
        } catch (err: any) {
            Alert.alert('Error', err?.message || 'Could not launch UPI app.');
        }
    }, [evaluated, upiId, recipientName, handleClose]);

    return (
        <View style={styles.root}>
            {visible && (
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose}>
                    <Animated.View
                        entering={FadeIn.duration(260)}
                        exiting={FadeOut.duration(240)}
                        style={[StyleSheet.absoluteFill, styles.backdrop]}
                    />
                </Pressable>
            )}

            {visible && (
                <Animated.View
                    entering={SlideInDown.springify().damping(22).stiffness(180).mass(0.7)}
                    exiting={SlideOutDown.duration(280)}
                    style={[
                        styles.sheet,
                        { paddingBottom: insets.bottom + 14 },
                    ]}
                >
                    <GlassView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />

                    <View style={styles.handle} />

                    <View style={styles.headerRow}>
                        <Pressable hitSlop={10} onPress={handleClose} style={styles.headerIconBtn}>
                            <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.85)" />
                        </Pressable>

                        <View style={styles.headerCenter}>
                            <Animated.View
                                sharedTransitionTag={PAY_SHARED_TAG}
                                style={[styles.headerPaymentBadge, { backgroundColor: accent }]}
                            >
                                <MaterialIcons name="currency-rupee" size={16} color="#fff" />
                            </Animated.View>
                            <Text style={styles.headerTitle}>Pay via UPI</Text>
                        </View>

                        <Pressable
                            hitSlop={10}
                            onPress={() => Alert.alert('Scan QR', 'Coming soon')}
                            style={styles.headerIconBtn}
                        >
                            <MaterialIcons name="qr-code-scanner" size={20} color="rgba(255,255,255,0.85)" />
                        </Pressable>
                    </View>

                    <View style={styles.amountWrap}>
                        <Text style={styles.amountCurrency}>₹</Text>
                        <Text
                            style={styles.amountValue}
                            numberOfLines={1}
                            adjustsFontSizeToFit
                        >
                            {expression || '0'}
                        </Text>
                    </View>
                    {hasOperator ? (
                        <Text style={styles.amountEval}>
                            = ₹{evaluated.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </Text>
                    ) : (
                        <Text style={styles.amountHint}>Tap + − × ÷ to calculate inline</Text>
                    )}

                    <View style={styles.recipientStack}>
                        <View style={styles.recipientRow}>
                            <GlassView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
                            <MaterialIcons
                                name="alternate-email"
                                size={18}
                                color="rgba(255,255,255,0.55)"
                                style={{ marginLeft: 12 }}
                            />
                            <TextInput
                                style={styles.recipientInput}
                                value={upiId}
                                onChangeText={setUpiId}
                                placeholder="UPI ID  (e.g. name@okhdfcbank)"
                                placeholderTextColor="rgba(255,255,255,0.4)"
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="email-address"
                                underlineColorAndroid="transparent"
                            />
                        </View>

                        <View style={styles.recipientRow}>
                            <GlassView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />
                            <MaterialIcons
                                name="person-outline"
                                size={18}
                                color="rgba(255,255,255,0.55)"
                                style={{ marginLeft: 12 }}
                            />
                            <TextInput
                                style={styles.recipientInput}
                                value={recipientName}
                                onChangeText={setRecipientName}
                                placeholder="Recipient name  (optional)"
                                placeholderTextColor="rgba(255,255,255,0.4)"
                                autoCorrect={false}
                                underlineColorAndroid="transparent"
                            />
                        </View>
                    </View>

                    <View style={styles.keypad}>
                        {KEYPAD.map((row, ri) => (
                            <View key={ri} style={styles.keypadRow}>
                                {row.map((label) => (
                                    <Key
                                        key={label}
                                        label={label}
                                        accent={accent}
                                        onPress={() => handleKey(label)}
                                    />
                                ))}
                            </View>
                        ))}
                    </View>

                    <Pressable
                        onPress={handleSend}
                        style={({ pressed }) => [
                            styles.sendBtn,
                            { backgroundColor: accent },
                            pressed && { opacity: 0.85 },
                        ]}
                    >
                        <Text style={styles.sendBtnText}>
                            Send ₹{evaluated.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                        </Text>
                        <MaterialIcons name="arrow-forward" size={18} color="#fff" />
                    </Pressable>
                </Animated.View>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { backgroundColor: 'rgba(0,0,0,0.55)' },
    sheet: {
        height: '88%',
        borderTopLeftRadius: 26,
        borderTopRightRadius: 26,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.6)',
        paddingTop: 8,
    },
    handle: {
        alignSelf: 'center',
        width: 44,
        height: 4,
        borderRadius: 2,
        backgroundColor: 'rgba(255,255,255,0.25)',
        marginTop: 4,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        marginTop: 14,
    },
    headerIconBtn: {
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.07)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    headerCenter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerPaymentBadge: {
        width: 26,
        height: 26,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    amountWrap: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'center',
        marginTop: 22,
        paddingHorizontal: 24,
    },
    amountCurrency: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 26,
        fontWeight: '600',
        marginRight: 4,
    },
    amountValue: {
        color: '#fff',
        fontSize: 52,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    amountEval: {
        color: 'rgba(255,255,255,0.78)',
        fontSize: 14,
        fontWeight: '700',
        textAlign: 'center',
        marginTop: 4,
        letterSpacing: 0.2,
    },
    amountHint: {
        color: 'rgba(255,255,255,0.32)',
        fontSize: 11,
        fontWeight: '500',
        textAlign: 'center',
        marginTop: 6,
        letterSpacing: 0.3,
    },
    recipientStack: {
        marginTop: 18,
        marginHorizontal: 14,
        gap: 8,
    },
    recipientRow: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        height: 44,
    },
    recipientInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
        fontWeight: '500',
        paddingHorizontal: 10,
        padding: 0,
    },
    keypad: {
        marginTop: 14,
        paddingHorizontal: 14,
        gap: 8,
    },
    keypadRow: {
        flexDirection: 'row',
        gap: 8,
    },
    keyTouchable: {
        flex: 1,
    },
    key: {
        flex: 1,
        height: 52,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
    },
    keyOp: {
        backgroundColor: 'rgba(255,255,255,0.04)',
    },
    keyText: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '600',
    },
    sendBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 14,
        marginHorizontal: 14,
        height: 52,
        borderRadius: 16,
    },
    sendBtnText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
});

export { PAY_SHARED_TAG };
