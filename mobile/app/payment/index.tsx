import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    Linking,
    Alert,
    Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, {
    FadeIn,
    FadeOut,
    SlideInDown,
    SlideOutDown,
} from 'react-native-reanimated';
import GlassView from '../../components/ui/GlassView';
import { useApp } from '../../context/AppContext';

const PAY_SHARED_TAG = 'soul-pay-pill';

const OP_DISPLAY_TO_INTERNAL: Record<string, string> = {
    '÷': '/',
    '×': '*',
    '−': '-',
    '+': '+',
};

const safeEvalExpression = (display: string): number => {
    const internal = display
        .replace(/\s/g, '')
        .replace(/[÷×−]/g, (c) => OP_DISPLAY_TO_INTERNAL[c] || c);
    if (!internal) return 0;
    if (!/^[\d+\-*/.]+$/.test(internal)) return 0;
    if (/^\d+(\.\d+)?$/.test(internal)) return parseFloat(internal);
    if (/[+\-*/.]$/.test(internal)) {
        // dangling operator → drop it for live evaluation
        const trimmed = internal.replace(/[+\-*/.]+$/, '');
        if (!trimmed) return 0;
        try {
            // eslint-disable-next-line no-new-func
            const r = new Function(`"use strict"; return (${trimmed})`)();
            if (typeof r !== 'number' || !isFinite(r)) return 0;
            return Math.round(r * 100) / 100;
        } catch {
            return 0;
        }
    }
    try {
        // eslint-disable-next-line no-new-func
        const r = new Function(`"use strict"; return (${internal})`)();
        if (typeof r !== 'number' || !isFinite(r)) return 0;
        return Math.round(r * 100) / 100;
    } catch {
        return 0;
    }
};

const formatINR = (n: number): string =>
    n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

const DIAL_PAD: string[][] = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', '⌫'],
];

const OPERATORS = ['+', '−', '×', '÷'];

// iOS doesn't have a system-level upi:// chooser like Android. Each UPI
// app registers its own scheme, so we fall back to them in priority order
// if the generic upi:// scheme isn't claimed by anything.
const UPI_FALLBACK_APPS: { name: string; scheme: string }[] = [
    { name: 'Google Pay', scheme: 'gpay://upi/pay' },
    { name: 'Google Pay', scheme: 'tez://upi/pay' },
    { name: 'PhonePe', scheme: 'phonepe://pay' },
    { name: 'Paytm', scheme: 'paytmmp://pay' },
    { name: 'Paytm', scheme: 'paytm://pay' },
    { name: 'BHIM', scheme: 'bhim://pay' },
    { name: 'CRED', scheme: 'credpay://pay' },
    { name: 'MobiKwik', scheme: 'mobikwik://pay' },
    { name: 'Amazon Pay', scheme: 'amazonpay://pay' },
];

export default function PaymentScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { activeTheme } = useApp() as any;
    const accent = activeTheme?.primary || '#ff0080';

    const [visible, setVisible] = useState(true);
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [expression, setExpression] = useState('0');
    const [upiId, setUpiId] = useState('');
    const [note, setNote] = useState('');

    const hasOperator = useMemo(() => /[÷×−+]/.test(expression), [expression]);
    const total = useMemo(() => safeEvalExpression(expression), [expression]);

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
            if (key === '⌫') {
                if (prev.length <= 1) return '0';
                return prev.slice(0, -1);
            }
            if (key === '.') {
                const lastNumber = prev.split(/[÷×−+]/).pop() || '';
                if (lastNumber.includes('.')) return prev;
                if (!lastNumber) return prev + '0.';
                return prev + key;
            }
            if (OPERATORS.includes(key)) {
                if (prev === '0') return prev;
                const last = prev.slice(-1);
                if (OPERATORS.includes(last)) return prev.slice(0, -1) + key;
                if (last === '.') return prev;
                return prev + key;
            }
            // digit
            if (prev === '0') return key;
            return prev + key;
        });
    }, []);

    const handleSend = useCallback(async () => {
        if (total <= 0) {
            Alert.alert('Amount', 'Enter a valid amount.');
            return;
        }
        const trimmedUpi = upiId.trim();
        if (!trimmedUpi || !trimmedUpi.includes('@')) {
            Alert.alert('UPI ID', 'Enter a valid UPI ID (e.g. name@okhdfcbank).');
            return;
        }
        const queryString = new URLSearchParams({
            pa: trimmedUpi,
            pn: 'Recipient',
            am: total.toFixed(2),
            cu: 'INR',
            tn: note.trim() || 'Paid via Soul',
        }).toString();

        const tryOpen = async (url: string): Promise<boolean> => {
            try {
                const ok = await Linking.canOpenURL(url);
                if (!ok) return false;
                await Linking.openURL(url);
                return true;
            } catch {
                return false;
            }
        };

        // Android: upi:// is the canonical NPCI scheme; system shows app chooser.
        // iOS: try upi:// first (some apps register it), then fall back to
        // each app-specific scheme until one is installed.
        const opened = await tryOpen(`upi://pay?${queryString}`);
        if (opened) {
            handleClose();
            return;
        }

        if (Platform.OS === 'ios') {
            for (const app of UPI_FALLBACK_APPS) {
                const ok = await tryOpen(`${app.scheme}?${queryString}`);
                if (ok) {
                    handleClose();
                    return;
                }
            }
        }

        Alert.alert(
            'No UPI app found',
            Platform.OS === 'ios'
                ? 'Install a UPI app like PhonePe, Google Pay, or Paytm to send money.'
                : 'No UPI-capable app is installed on this device.',
        );
    }, [total, upiId, note, handleClose]);

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
                        { paddingBottom: Math.max(insets.bottom, 12) + 8 },
                    ]}
                >
                    <GlassView intensity={75} tint="dark" style={StyleSheet.absoluteFill} />

                    <View style={styles.handle} />

                    {/* Header */}
                    <View style={styles.header}>
                        <Pressable onPress={handleClose} style={styles.headerBtn} hitSlop={6}>
                            <MaterialIcons name="arrow-back" size={20} color="#fff" />
                        </Pressable>

                        <View style={styles.headerCenter}>
                            <Animated.View
                                sharedTransitionTag={PAY_SHARED_TAG}
                                style={[styles.headerBadge, { backgroundColor: accent }]}
                            >
                                <MaterialIcons name="currency-rupee" size={14} color="#fff" />
                            </Animated.View>
                            <Text style={styles.headerTitle}>Send Money</Text>
                        </View>

                        <Pressable
                            onPress={() => Alert.alert('Scan QR', 'Coming soon')}
                            style={styles.headerBtn}
                            hitSlop={6}
                        >
                            <MaterialIcons name="qr-code-scanner" size={20} color="#fff" />
                        </Pressable>
                    </View>

                    {/* Recipient card */}
                    <View style={styles.recipientCard}>
                        <View style={styles.recipientAvatar}>
                            <MaterialIcons name="person" size={22} color="rgba(255,255,255,0.6)" />
                        </View>
                        <TextInput
                            style={styles.recipientInput}
                            value={upiId}
                            onChangeText={setUpiId}
                            placeholder="Enter UPI ID  (name@okhdfcbank)"
                            placeholderTextColor="rgba(255,255,255,0.38)"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="email-address"
                            underlineColorAndroid="transparent"
                        />
                    </View>

                    {/* Amount hero */}
                    <View style={styles.amountWrap}>
                        <View style={styles.amountRow}>
                            <Text style={styles.amountCurrency}>₹</Text>
                            <Text
                                style={styles.amountValue}
                                numberOfLines={1}
                                adjustsFontSizeToFit
                                minimumFontScale={0.4}
                            >
                                {expression}
                            </Text>
                        </View>
                        {hasOperator ? (
                            <Text style={[styles.amountEval, { color: accent }]}>
                                = ₹{formatINR(total)}
                            </Text>
                        ) : (
                            <Text style={styles.amountHint}>tap operators to do quick math</Text>
                        )}
                    </View>

                    {/* Note */}
                    <View style={styles.noteRow}>
                        <MaterialIcons name="edit" size={14} color="rgba(255,255,255,0.4)" />
                        <TextInput
                            style={styles.noteInput}
                            value={note}
                            onChangeText={setNote}
                            placeholder="Add a note"
                            placeholderTextColor="rgba(255,255,255,0.35)"
                            underlineColorAndroid="transparent"
                            maxLength={50}
                        />
                    </View>

                    {/* Operators */}
                    <View style={styles.opsRow}>
                        {OPERATORS.map((op) => (
                            <Pressable
                                key={op}
                                onPress={() => handleKey(op)}
                                style={({ pressed }) => [
                                    styles.opChip,
                                    pressed && { backgroundColor: 'rgba(255,255,255,0.12)' },
                                ]}
                            >
                                <Text style={[styles.opChipText, { color: accent }]}>{op}</Text>
                            </Pressable>
                        ))}
                    </View>

                    {/* Dial pad */}
                    <View style={styles.dialpad}>
                        {DIAL_PAD.map((row, ri) => (
                            <View key={ri} style={styles.dialRow}>
                                {row.map((k) => (
                                    <Pressable
                                        key={k}
                                        onPress={() => handleKey(k)}
                                        android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: false }}
                                        style={({ pressed }) => [
                                            styles.dialKey,
                                            pressed && { backgroundColor: 'rgba(255,255,255,0.08)' },
                                        ]}
                                    >
                                        {k === '⌫' ? (
                                            <MaterialIcons name="backspace" size={22} color="#fff" />
                                        ) : (
                                            <Text style={styles.dialKeyText}>{k}</Text>
                                        )}
                                    </Pressable>
                                ))}
                            </View>
                        ))}
                    </View>

                    {/* Send */}
                    <Pressable
                        onPress={handleSend}
                        style={({ pressed }) => [
                            styles.sendBtn,
                            { backgroundColor: accent },
                            pressed && { opacity: 0.85 },
                        ]}
                    >
                        <MaterialIcons name="lock" size={14} color="rgba(255,255,255,0.9)" />
                        <Text style={styles.sendBtnText}>Pay ₹{formatINR(total)}</Text>
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
        height: '92%',
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        overflow: 'hidden',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        backgroundColor: 'rgba(15,15,18,0.65)',
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
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        marginTop: 12,
    },
    headerBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    headerCenter: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    headerBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    recipientCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 14,
        marginTop: 16,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 16,
        backgroundColor: 'rgba(255,255,255,0.05)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.08)',
        gap: 10,
    },
    recipientAvatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.08)',
    },
    recipientInput: {
        flex: 1,
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
        padding: 0,
    },
    amountWrap: {
        alignItems: 'center',
        marginTop: 22,
        paddingHorizontal: 24,
        minHeight: 76,
        justifyContent: 'center',
    },
    amountRow: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'center',
    },
    amountCurrency: {
        color: 'rgba(255,255,255,0.55)',
        fontSize: 28,
        fontWeight: '600',
        marginRight: 4,
    },
    amountValue: {
        color: '#fff',
        fontSize: 56,
        fontWeight: '700',
        letterSpacing: 0.5,
        textAlign: 'center',
    },
    amountEval: {
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
        marginTop: 4,
        letterSpacing: 0.3,
    },
    noteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 12,
        backgroundColor: 'rgba(255,255,255,0.04)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.06)',
        gap: 6,
        maxWidth: '85%',
    },
    noteInput: {
        flex: 1,
        color: '#fff',
        fontSize: 12.5,
        fontWeight: '500',
        padding: 0,
        minWidth: 140,
    },
    opsRow: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 12,
        marginTop: 14,
        paddingHorizontal: 14,
    },
    opChip: {
        width: 52,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    opChipText: {
        fontSize: 18,
        fontWeight: '700',
    },
    dialpad: {
        marginTop: 12,
        paddingHorizontal: 8,
    },
    dialRow: {
        flexDirection: 'row',
    },
    dialKey: {
        flex: 1,
        height: 56,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 14,
    },
    dialKeyText: {
        color: '#fff',
        fontSize: 26,
        fontWeight: '600',
        lineHeight: 32,
        includeFontPadding: false,
    },
    sendBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        marginTop: 12,
        marginHorizontal: 14,
        height: 54,
        borderRadius: 18,
    },
    sendBtnText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.3,
    },
});

export { PAY_SHARED_TAG };
