import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
    View, Text, Pressable, StyleSheet, StatusBar,
    TextInput, ScrollView, Alert, Modal, Animated as RNAnimated,
    KeyboardAvoidingView, useWindowDimensions, Platform, ActivityIndicator, BackHandler
} from 'react-native';
import { Image } from 'expo-image';
import { GlassView } from '../components/ui/GlassView';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
const DEFAULT_AVATAR = '';
import * as ImagePicker from 'expo-image-picker';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useApp } from '../context/AppContext';
import { SoulAvatar } from '../components/SoulAvatar';
import { SUPPORT_SHARED_TRANSITIONS } from '../constants/sharedTransitions';
import { authService } from '../services/AuthService';
import { proxySupabaseUrl } from '../config/api';
import { setProfileEditSourceHidden } from '../services/profileEditMorphState';
import { CountryPicker } from '../components/CountryPicker';
import { COUNTRIES, Country } from '../constants/Countries';
import Animated, {
    Easing,
    Extrapolation,
    SharedTransition,
    interpolate,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';

const AnimatedImage = Animated.createAnimatedComponent(Image);

const profileTransition = SharedTransition.custom((values) => {
    'worklet';
    return {
        height: withTiming(values.targetHeight, { duration: 400 }),
        width: withTiming(values.targetWidth, { duration: 400 }),
        originX: withTiming(values.targetOriginX, { duration: 400 }),
        originY: withTiming(values.targetOriginY, { duration: 400 }),
        borderRadius: withTiming(values.targetBorderRadius, { duration: 400 }),
    };
});


const SettingRow = ({ label, value, icon, onPress }: {
    label: string;
    value: string;
    icon: string;
    onPress: () => void;
}) => (
    <Pressable style={styles.settingRow} onPress={onPress}>
        <View style={styles.settingContent}>
            {label ? <Text style={styles.settingLabel}>{label}</Text> : null}
            <Text 
                style={[
                    styles.settingValue, 
                    !value && { color: 'rgba(255,255,255,0.3)' }
                ]} 
                numberOfLines={1}
            >
                {value || 'Not set'}
            </Text>
        </View>
        <MaterialIcons name="chevron-right" size={20} color="rgba(255,255,255,0.4)" />
    </Pressable>
);

const profileMorphTransition = SharedTransition.custom((values) => {
    'worklet';
    const morph = {
        duration: 400,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    };
    return {
        originX: withTiming(values.targetOriginX, morph),
        originY: withTiming(values.targetOriginY, morph),
        width: withTiming(values.targetWidth, morph),
        height: withTiming(values.targetHeight, morph),
        borderRadius: withTiming(values.targetBorderRadius, morph),
    };
}).duration(400);

const profileBoundsTransition = SharedTransition.custom((values) => {
    'worklet';
    const morph = {
        duration: 400,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    };
    return {
        originX: withTiming(values.targetOriginX, morph),
        originY: withTiming(values.targetOriginY, morph),
        width: withTiming(values.targetWidth, morph),
        height: withTiming(values.targetHeight, morph),
        borderRadius: withTiming(values.targetBorderRadius, morph),
    };
}).duration(400);

export default function ProfileEditScreen() {
    const enableSharedMorph = SUPPORT_SHARED_TRANSITIONS;
    const targetSize = 180;
    const targetRadius = 90;
    const sourceImageBaseTop = -40;
    const sourceImageHeightMultiplier = 1.4;

    const { width } = useWindowDimensions();
    const router = useRouter();
    const navigation = useNavigation();
    const params = useLocalSearchParams<{ heroX?: string; heroY?: string; heroW?: string; heroH?: string; heroScrollY?: string }>();
    const { currentUser, updateProfile, changeUsername, activeTheme } = useApp();
    const heroOrigin = {
        x: Number(Array.isArray(params.heroX) ? params.heroX[0] : params.heroX),
        y: Number(Array.isArray(params.heroY) ? params.heroY[0] : params.heroY),
        width: Number(Array.isArray(params.heroW) ? params.heroW[0] : params.heroW),
        height: Number(Array.isArray(params.heroH) ? params.heroH[0] : params.heroH),
    };
    const hasHeroMorph = Number.isFinite(heroOrigin.x)
        && Number.isFinite(heroOrigin.y)
        && Number.isFinite(heroOrigin.width)
        && Number.isFinite(heroOrigin.height)
        && heroOrigin.width > 0
        && heroOrigin.height > 0;
    const sourceScrollY = Number(Array.isArray(params.heroScrollY) ? params.heroScrollY[0] : params.heroScrollY) || 0;
    const sourceParallaxTranslateY = Math.max(-100, Math.min(100, sourceScrollY * 0.3125));
    const sourceParallaxScale = sourceScrollY < 0
        ? 1 + (Math.min(320, Math.abs(sourceScrollY)) / 320) * 0.5
        : 1;

    const [name, setName] = useState(currentUser?.name || '');
    const [username, setUsername] = useState(currentUser?.username || '');
    const [bio, setBio] = useState(currentUser?.bio || '');
    const [avatar, setAvatar] = useState(currentUser?.avatar || '');
    const [birthdate, setBirthdate] = useState(currentUser?.birthdate || '');
    const [countryModal, setCountryModal] = useState(false);
    const [country, setCountry] = useState<Country | null>(
        currentUser?.country ? COUNTRIES.find(c => c.name === currentUser.country) || null : null
    );
    const [tempBirthdate, setTempBirthdate] = useState(currentUser?.birthdate || '');
    const [pickerDate, setPickerDate] = useState<Date>(new Date());
    const [showImageModal, setShowImageModal] = useState(false);
    const [showFullImage, setShowFullImage] = useState(false);
    const [isEditing, setIsEditing] = useState<'name' | 'bio' | 'username' | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
    const [isContentReady, setIsContentReady] = useState(!hasHeroMorph);
    const morphProgress = useSharedValue(hasHeroMorph ? 0 : 1);
    const chromeOpacity = useSharedValue(hasHeroMorph ? 0 : 1);
    const isClosingRef = useRef(false);
    const allowNativePopRef = useRef(false);
    const entryHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sourceRevealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dismissFinishTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearMorphTimers = React.useCallback(() => {
        if (entryHideTimeoutRef.current) {
            clearTimeout(entryHideTimeoutRef.current);
            entryHideTimeoutRef.current = null;
        }
        if (sourceRevealTimeoutRef.current) {
            clearTimeout(sourceRevealTimeoutRef.current);
            sourceRevealTimeoutRef.current = null;
        }
        if (dismissFinishTimeoutRef.current) {
            clearTimeout(dismissFinishTimeoutRef.current);
            dismissFinishTimeoutRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (currentUser) {
            if (currentUser.name && !isEditing) setName(currentUser.name);
            if (currentUser.username && !isEditing) setUsername(currentUser.username);
            if (currentUser.bio && !isEditing) setBio(currentUser.bio);
            if (currentUser.avatar) setAvatar(currentUser.avatar);
            // Only sync birthdate if we aren't currently picking one
            // and the value is actually different from what we have locally
            if (currentUser.birthdate && !showDatePicker && currentUser.birthdate !== birthdate) {
                setBirthdate(currentUser.birthdate);
                setTempBirthdate(currentUser.birthdate);
            }
        }
    }, [currentUser?.birthdate, currentUser?.name, currentUser?.bio, currentUser?.avatar, isEditing, showDatePicker]);

    useEffect(() => {
        clearMorphTimers();

        if (!hasHeroMorph) {
            setProfileEditSourceHidden(false);
            setIsContentReady(true);
            morphProgress.value = 1;
            chromeOpacity.value = 1;
            return;
        }

        setProfileEditSourceHidden(false);
        setIsContentReady(false);
        entryHideTimeoutRef.current = setTimeout(() => {
            setProfileEditSourceHidden(true);
            entryHideTimeoutRef.current = null;
        }, 18);
        morphProgress.value = withTiming(1, {
            duration: 460,
            easing: Easing.bezier(0.22, 1, 0.36, 1),
        }, (finished) => {
            if (finished) {
                runOnJS(setIsContentReady)(true);
            }
        });
        chromeOpacity.value = 1;

        return () => {
            clearMorphTimers();
            setProfileEditSourceHidden(false);
        };
    }, [chromeOpacity, clearMorphTimers, hasHeroMorph, morphProgress]);

    const slideAnim = useRef(new RNAnimated.Value(0)).current;
    const heroMorphAnimatedStyle = useAnimatedStyle(() => {
        const targetLeft = (width - targetSize) / 2;
        const targetTop = 118;

        if (!hasHeroMorph) {
            return {
                left: targetLeft,
                top: targetTop,
                width: targetSize,
                height: targetSize,
                borderRadius: targetRadius,
            };
        }

        const sourceCenterX = heroOrigin.x + (heroOrigin.width / 2);
        const sourceCenterY = heroOrigin.y + (heroOrigin.height / 2);
        const targetCenterX = targetLeft + (targetSize / 2);
        const targetCenterY = targetTop + (targetSize / 2);

        const initialScaleX = heroOrigin.width / targetSize;
        const initialScaleY = heroOrigin.height / targetSize;

        return {
            left: targetLeft,
            top: targetTop,
            width: targetSize,
            height: targetSize,
            borderRadius: interpolate(morphProgress.value, [0, 1], [28, targetRadius], Extrapolation.CLAMP),
            opacity: interpolate(morphProgress.value, [0, 0.975, 1], [1, 1, 0], Extrapolation.CLAMP),
            transform: [
                {
                    translateX: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [sourceCenterX - targetCenterX, 0],
                        Extrapolation.CLAMP
                    ),
                },
                {
                    translateY: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [sourceCenterY - targetCenterY, 0],
                        Extrapolation.CLAMP
                    ),
                },
                {
                    scaleX: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [initialScaleX, 1],
                        Extrapolation.CLAMP
                    ),
                },
                {
                    scaleY: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [initialScaleY, 1],
                        Extrapolation.CLAMP
                    ),
                },
            ] as any,
        };
    });

    const heroMorphImageAnimatedStyle = useAnimatedStyle(() => {
        if (!hasHeroMorph) {
            return {
                top: 0,
                height: targetSize,
                transform: [{ translateY: 0 }, { scale: 1 }] as any,
            };
        }

        const outerScaleY = interpolate(
            morphProgress.value,
            [0, 1],
            [heroOrigin.height / targetSize, 1],
            Extrapolation.CLAMP
        );

        return {
            top: interpolate(
                morphProgress.value,
                [0, 1],
                [sourceImageBaseTop / outerScaleY, 0],
                Extrapolation.CLAMP
            ),
            height: interpolate(
                morphProgress.value,
                [0, 1],
                [targetSize * sourceImageHeightMultiplier, targetSize],
                Extrapolation.CLAMP
            ),
            transform: [
                {
                    translateY: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [sourceParallaxTranslateY / outerScaleY, 0],
                        Extrapolation.CLAMP
                    ),
                },
                {
                    scale: interpolate(
                        morphProgress.value,
                        [0, 1],
                        [sourceParallaxScale, 1],
                        Extrapolation.CLAMP
                    ),
                },
            ] as any,
        };
    });

    const backdropAnimatedStyle = useAnimatedStyle(() => ({
        opacity: hasHeroMorph
            ? interpolate(morphProgress.value, [0, 0.2, 1], [0, 0.45, 1], Extrapolation.CLAMP)
            : 1,
    }));

    const chromeAnimatedStyle = useAnimatedStyle(() => ({
        opacity: hasHeroMorph
            ? interpolate(morphProgress.value, [0, 0.5, 0.86, 1], [0, 0, 0.5, 1], Extrapolation.CLAMP)
            : chromeOpacity.value,
        transform: [{ translateY: interpolate(morphProgress.value, [0, 1], [18, 0], Extrapolation.CLAMP) }],
    }));

    const contentAnimatedStyle = useAnimatedStyle(() => ({
        opacity: hasHeroMorph
            ? interpolate(morphProgress.value, [0, 0.56, 0.9, 1], [0, 0, 0.45, 1], Extrapolation.CLAMP)
            : chromeOpacity.value,
        transform: [{ translateY: interpolate(morphProgress.value, [0, 1], [22, 0], Extrapolation.CLAMP) }],
    }));

    const avatarRevealAnimatedStyle = useAnimatedStyle(() => ({
        opacity: hasHeroMorph
            ? interpolate(morphProgress.value, [0, 0.96, 1], [0, 0, 1], Extrapolation.CLAMP)
            : 1,
        transform: [
            {
                scale: hasHeroMorph
                    ? interpolate(morphProgress.value, [0, 0.96, 1], [0.985, 0.985, 1], Extrapolation.CLAMP)
                    : 1,
            },
        ] as any,
    }));

    const finishDismiss = React.useCallback((action?: any) => {
        allowNativePopRef.current = true;
        if (action) {
            navigation.dispatch(action);
            return;
        }
        if (navigation.canGoBack()) {
            navigation.goBack();
        } else {
            router.back();
        }
    }, [navigation, router]);

    const runDismissAnimation = React.useCallback((action?: any) => {
        if (isClosingRef.current) return;
        isClosingRef.current = true;
        clearMorphTimers();

        if (!hasHeroMorph) {
            setProfileEditSourceHidden(false);
            finishDismiss(action);
            return;
        }

        setIsContentReady(false);
        morphProgress.value = withTiming(0, {
            duration: 420,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
        });
        sourceRevealTimeoutRef.current = setTimeout(() => {
            setProfileEditSourceHidden(false);
            sourceRevealTimeoutRef.current = null;
        }, 170);
        dismissFinishTimeoutRef.current = setTimeout(() => {
            finishDismiss(action);
            dismissFinishTimeoutRef.current = null;
        }, 300);
    }, [clearMorphTimers, finishDismiss, hasHeroMorph, morphProgress]);

    useEffect(() => {
        const unsubscribe = navigation.addListener('beforeRemove', (event: any) => {
            if (!hasHeroMorph || isClosingRef.current || allowNativePopRef.current) {
                return;
            }
            event.preventDefault();
            runDismissAnimation(event.data.action);
        });

        const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!hasHeroMorph || isClosingRef.current) {
                return false;
            }
            runDismissAnimation();
            return true;
        });

        return () => {
            allowNativePopRef.current = false;
            unsubscribe();
            backSubscription.remove();
        };
    }, [hasHeroMorph, navigation, runDismissAnimation]);

    const handleBack = () => {
        runDismissAnimation();
    };

    const showModal = () => {
        setShowImageModal(true);
        slideAnim.setValue(0);
        RNAnimated.timing(slideAnim, {
            toValue: 1,
            duration: 350,
            useNativeDriver: true,
        }).start();
    };

    const hideModal = () => {
        RNAnimated.timing(slideAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
        }).start(() => setShowImageModal(false));
    };

    const handleTakePhoto = async () => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Permission needed', 'Camera permission is required');
            return;
        }

        hideModal();

        // Small delay to allow modal animation to finish before launching native picker
        setTimeout(async () => {
            try {
                const result = await ImagePicker.launchCameraAsync({
                    mediaTypes: ['images'] as ImagePicker.MediaType[],
                    allowsEditing: true,
                    aspect: [1, 1],
                    quality: 0.8,
                });

                if (!result.canceled && result.assets[0]) {
                    const localUri = result.assets[0].uri;
                    
                    // Optimistic UI: Update local state immediately
                    setAvatar(localUri);
                    setIsUploadingAvatar(true);
                    
                    // Upload via Supabase Storage (proxied, reliable on all networks)
                    try {
                        const uploadedUrl = await authService.uploadAvatar(currentUser!.id, localUri);
                        if (uploadedUrl) {
                            await updateProfile({ avatar: uploadedUrl });
                        } else {
                            throw new Error('Upload failed');
                        }
                    } catch (error: any) {
                        const errMsg = error?.message || String(error);
                        console.warn('Avatar upload error (camera):', errMsg);
                        Alert.alert('Upload Failed', `Could not update profile photo. Please try again.\n\n${errMsg}`);
                    } finally {
                        setIsUploadingAvatar(false);
                    }
                }
            } catch (error) {
                Alert.alert('Camera Error', 'Could not open camera.');
            }
        }, 500);
    };

    const handleChoosePhoto = async () => {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Permission needed', 'Media library permission is required');
            return;
        }

        hideModal();

        setTimeout(async () => {
            try {
                const result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ['images'] as ImagePicker.MediaType[],
                    allowsEditing: true,
                    aspect: [1, 1],
                    quality: 0.8,
                    legacy: true,
                    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
                });

                if (!result.canceled && result.assets[0]) {
                    const localUri = result.assets[0].uri;
                    
                    // Optimistic UI: Update local state immediately
                    setAvatar(localUri);
                    setIsUploadingAvatar(true);

                    // Upload via Supabase Storage (proxied, reliable on all networks)
                    try {
                        const uploadedUrl = await authService.uploadAvatar(currentUser!.id, localUri);
                        if (uploadedUrl) {
                            await updateProfile({ avatar: uploadedUrl });
                        } else {
                            throw new Error('Upload failed');
                        }
                    } catch (error: any) {
                        const errMsg = error?.message || String(error);
                        console.warn('[ProfileEdit] Avatar update failed:', errMsg);
                        Alert.alert('Upload Failed', `Could not update profile photo. Please try again.\n\n${errMsg}`);
                    } finally {
                        setIsUploadingAvatar(false);
                    }
                }
            } catch (error) {
                console.log('Image picker error:', error);
            }
        }, 500);
    };

    const handleDeletePhoto = () => {
        hideModal();
        Alert.alert(
            'Delete Photo',
            'Are you sure you want to remove your profile photo?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                        const defaultAvatar = '';
                        setAvatar(defaultAvatar);
                        updateProfile({ avatar: defaultAvatar });
                    }
                }
            ]
        );
    };

    const handleSaveName = () => {
        if (name.trim()) {
            updateProfile({ name: name.trim() });
            setIsEditing(null);
        }
    };

    const handleSaveBio = () => {
        updateProfile({ bio: bio.trim() });
        setIsEditing(null);
    };

    const handleSaveUsername = async () => {
        if (!username.trim() || username.trim() === currentUser?.username) {
            setIsEditing(null);
            return;
        }

        const result = await changeUsername(username.trim());
        if (result.success) {
            setIsEditing(null);
            Alert.alert('Success', 'Username updated successfully');
        } else {
            Alert.alert('Error', result.error || 'Failed to update username');
        }
    };

    const handleDateChange = (event: any, selectedDate?: Date) => {
        if (Platform.OS === 'android') {
            setShowDatePicker(false);
        }
        
        if (event.type === 'dismissed') {
            setShowDatePicker(false);
            return;
        }
        
        if (selectedDate) {
            setPickerDate(selectedDate);
            // Format as YYYY-MM-DD using local time to avoid timezone shifts
            const year = selectedDate.getFullYear();
            const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
            const day = String(selectedDate.getDate()).padStart(2, '0');
            const formatted = `${year}-${month}-${day}`;
            setTempBirthdate(formatted);
            
            if (Platform.OS === 'android') {
                setBirthdate(formatted);
                updateProfile({ birthdate: formatted });
            }
        }
    };

    const confirmBirthdate = () => {
        setBirthdate(tempBirthdate);
        updateProfile({ birthdate: tempBirthdate });
        setShowDatePicker(false);
    };

    const formatDisplayDate = (dateString: string) => {
        if (!dateString) return '';
        const parts = dateString.split('-');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1]}-${parts[0]}`; // DD-MM-YYYY
        }
        return dateString;
    };


    return (
        <Animated.View 
            style={styles.container}
        >
            <StatusBar barStyle="light-content" />
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, backdropAnimatedStyle]} />

            {/* Header */}
            <Animated.View
                renderToHardwareTextureAndroid
                shouldRasterizeIOS
                style={[styles.header, chromeAnimatedStyle]}
            >
                <Pressable 
                    style={styles.backButton} 
                    onPress={handleBack}
                >
                    <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                </Pressable>
                <Text style={styles.headerTitle}>Profile</Text>
                <Pressable style={styles.backButton} onPress={showModal}>
                    <MaterialIcons name="edit" size={22} color="#ffffff" />
                </Pressable>
            </Animated.View>

            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                {isContentReady ? (
                <Animated.ScrollView
                    style={[styles.scrollView, contentAnimatedStyle]}
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {/* Profile Photo Section */}
                    <Animated.View
                        renderToHardwareTextureAndroid
                        shouldRasterizeIOS
                        style={[styles.avatarSection, chromeAnimatedStyle]}
                        collapsable={false}
                    >
                        <View style={styles.avatarContainer}>
                            <Pressable 
                                onPress={showModal} 
                                style={styles.avatarPressable}
                                collapsable={false}
                            >
                                {avatar ? (
                                    <AnimatedImage
                                        sharedTransitionTag={enableSharedMorph ? 'profile-image' : undefined}
                                        sharedTransitionStyle={enableSharedMorph ? profileMorphTransition : undefined}
                                        style={[styles.avatarImage, avatarRevealAnimatedStyle]}
                                        source={{ uri: proxySupabaseUrl(avatar) }}
                                        contentFit="cover"
                                        transition={0}
                                    />
                                ) : (
                                    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#262626', justifyContent: 'center', alignItems: 'center' }]}>
                                        <MaterialIcons name="person" size={100} color="rgba(255,255,255,0.2)" />
                                    </View>
                                )}
                                {isUploadingAvatar && (
                                    <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }]}>
                                        <ActivityIndicator color={activeTheme.primary} size="large" />
                                    </View>
                                )}
                            </Pressable>
                            <Animated.View style={[styles.avatarGlassBorder, avatarRevealAnimatedStyle]} pointerEvents="none" />
                        </View>
                    </Animated.View>

                    {/* Settings Rows */}
                    <Animated.View style={[styles.section, contentAnimatedStyle]}>
                        <Text style={styles.sectionLabel}>About</Text>
                        <View style={styles.settingsGroup}>
                            {isEditing === 'bio' ? (
                                <View style={styles.editRow}>
                                    <TextInput
                                        style={styles.editInput}
                                        value={bio}
                                        onChangeText={setBio}
                                        placeholder="Enter your bio"
                                        placeholderTextColor="rgba(255,255,255,0.45)"
                                        maxLength={140}
                                        multiline
                                    />
                                    <View style={styles.editActions}>
                                        <Pressable onPress={() => setIsEditing(null)} style={styles.cancelBtn}>
                                            <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                        </Pressable>
                                        <Pressable onPress={handleSaveBio} style={[styles.saveBtn, { backgroundColor: activeTheme.primary }]}>
                                            <MaterialIcons name="check" size={20} color="#ffffff" />
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <SettingRow
                                    label=""
                                    value={bio}
                                    icon="edit"
                                    onPress={() => setIsEditing('bio')}
                                />
                            )}
                        </View>
                    </Animated.View>

                    <Animated.View style={[styles.section, contentAnimatedStyle]}>
                        <Text style={styles.sectionLabel}>Soul ID</Text>
                        <View style={styles.settingsGroup}>
                            {isEditing === 'username' ? (
                                <View style={styles.editRow}>
                                    <View style={styles.inputPrefixWrapper}>
                                        <Text style={styles.inputPrefix}>@</Text>
                                        <TextInput
                                            style={[styles.editInput, { flex: 1, marginBottom: 0 }]}
                                            value={username}
                                            onChangeText={setUsername}
                                            placeholder="username"
                                            placeholderTextColor="rgba(255,255,255,0.45)"
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                    </View>
                                    <View style={[styles.editActions, { marginTop: 12 }]}>
                                        <Pressable onPress={() => setIsEditing(null)} style={styles.cancelBtn}>
                                            <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                        </Pressable>
                                        <Pressable onPress={handleSaveUsername} style={[styles.saveBtn, { backgroundColor: activeTheme.primary }]}>
                                            <MaterialIcons name="check" size={20} color="#ffffff" />
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <SettingRow
                                    label=""
                                    value={`@${currentUser?.username || 'user'}`}
                                    icon="alternate-email"
                                    onPress={() => {
                                        // 15 day check
                                        if (currentUser?.lastUsernameChange) {
                                            const lastDate = new Date(currentUser.lastUsernameChange);
                                            const now = new Date();
                                            const diff = Math.ceil(Math.abs(now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
                                            if (diff < 15) {
                                                Alert.alert('Hold on!', `You can change your username again in ${15 - diff} days.`);
                                                return;
                                            }
                                        }
                                        setIsEditing('username');
                                    }}
                                />
                            )}
                        </View>
                    </Animated.View>

                    <Animated.View style={[styles.section, contentAnimatedStyle]}>
                        <Text style={styles.sectionLabel}>Name</Text>
                        <View style={styles.settingsGroup}>
                            {isEditing === 'name' ? (
                                <View style={styles.editRow}>
                                    <TextInput
                                        style={styles.editInput}
                                        value={name}
                                        onChangeText={setName}
                                        placeholder="Enter your name"
                                        placeholderTextColor="rgba(255,255,255,0.45)"
                                        maxLength={25}
                                    />
                                    <View style={styles.editActions}>
                                        <Pressable onPress={() => setIsEditing(null)} style={styles.cancelBtn}>
                                            <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                        </Pressable>
                                        <Pressable onPress={handleSaveName} style={[styles.saveBtn, { backgroundColor: activeTheme.primary }]}>
                                            <MaterialIcons name="check" size={20} color="#ffffff" />
                                        </Pressable>
                                    </View>
                                </View>
                            ) : (
                                <SettingRow
                                    label=""
                                    value={name}
                                    icon="person"
                                    onPress={() => setIsEditing('name')}
                                />
                            )}
                        </View>
                    </Animated.View>

                    <Animated.View style={[styles.section, contentAnimatedStyle]}>
                        <Text style={styles.sectionLabel}>Birthdate</Text>
                        <View style={styles.settingsGroup}>
                            <SettingRow
                                label=""
                                value={formatDisplayDate(showDatePicker ? tempBirthdate : birthdate)}
                                icon="cake"
                                onPress={() => {
                                    setTempBirthdate(birthdate);
                                    const parts = birthdate ? birthdate.split('-') : [];
                                    if (parts.length === 3) {
                                        setPickerDate(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0));
                                    } else {
                                        setPickerDate(new Date());
                                    }
                                    setShowDatePicker(true);
                                }}
                            />
                        </View>
                    </Animated.View>

                    <Animated.View style={[styles.section, contentAnimatedStyle]}>
                        <Text style={styles.sectionLabel}>Country</Text>
                        <View style={styles.settingsGroup}>
                            <SettingRow
                                label=""
                                value={country ? `${country.flag} ${country.name}` : 'Not set'}
                                icon="public"
                                onPress={() => setCountryModal(true)}
                            />
                        </View>
                    </Animated.View>

                    {/* Smart Birthday Picker Modal */}
                    <Modal
                        visible={showDatePicker}
                        transparent
                        animationType="slide"
                        onRequestClose={() => setShowDatePicker(false)}
                    >
                        <View style={styles.modalOverlay}>
                            <Pressable style={styles.modalBackdrop} onPress={() => setShowDatePicker(false)} />
                            <RNAnimated.View style={[styles.modalContent, { minHeight: 380 }]}>
                                <View style={styles.modalContentWrapper}>
                                    <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                                    <View style={styles.modalHeader}>
                                        <Text style={styles.modalTitle}>Choose Birthdate</Text>
                                        <View style={{ flexDirection: 'row', gap: 12 }}>
                                            <Pressable 
                                                onPress={() => setShowDatePicker(false)} 
                                                style={[styles.modalClose, { backgroundColor: 'rgba(255,255,255,0.05)' }]}
                                            >
                                                <MaterialIcons name="close" size={20} color="rgba(255,255,255,0.5)" />
                                            </Pressable>
                                            <Pressable 
                                                onPress={confirmBirthdate} 
                                                style={[styles.saveBtn, { backgroundColor: activeTheme.primary }]}
                                            >
                                                <MaterialIcons name="check" size={24} color="#ffffff" />
                                            </Pressable>
                                        </View>
                                    </View>
                                    
                                    <View style={{ padding: 20, minHeight: 250, justifyContent: 'center', alignItems: 'center' }}>
                                        <DateTimePicker
                                            value={pickerDate}
                                            mode="date"
                                            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                                            onChange={handleDateChange}
                                            maximumDate={new Date()}
                                            themeVariant="dark"
                                            textColor="#ffffff"
                                            accentColor={activeTheme.primary}
                                            style={{ height: 200, width: '100%' }}
                                        />
                                    </View>
                                </View>
                            </RNAnimated.View>
                        </View>
                    </Modal>
                </Animated.ScrollView>
                ) : (
                <Animated.View style={[styles.scrollView, styles.shellPlaceholder]} />
                )}
            </KeyboardAvoidingView>

            {hasHeroMorph && avatar ? (
                <Animated.View
                    pointerEvents="none"
                    renderToHardwareTextureAndroid
                    shouldRasterizeIOS
                    style={[styles.heroMorphShell, heroMorphAnimatedStyle]}
                >
                    <Animated.View style={[styles.heroMorphImageWrapper, heroMorphImageAnimatedStyle]}>
                        <Image
                            source={{ uri: proxySupabaseUrl(avatar) }}
                            style={styles.heroMorphImage}
                            contentFit="cover"
                            transition={0}
                        />
                    </Animated.View>
                </Animated.View>
            ) : null}

            {/* Full Image Modal */}
            <Modal visible={showFullImage} transparent animationType="fade">
                <View style={styles.fullImageModal}>
                    <View style={styles.fullImageHeader}>
                        <Pressable onPress={() => setShowFullImage(false)} style={styles.closeBtn}>
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                        </Pressable>
                        <Text style={styles.fullImageTitle}>Profile picture</Text>
                        <View style={styles.fullImageActions}>
                            <Pressable onPress={showModal} style={styles.editIconBtn}>
                                <MaterialIcons name="edit" size={22} color="#ffffff" />
                            </Pressable>
                        </View>
                    </View>
                    <View style={styles.fullImageContainer}>
                        <Image source={{ uri: avatar }} style={styles.fullImage} resizeMode="contain" />
                    </View>
                </View>
            </Modal>

            {/* Edit Photo Modal */}
            <Modal visible={showImageModal} transparent animationType="fade">
                <View style={styles.modalOverlay}>
                    <Pressable style={styles.modalBackdrop} onPress={hideModal} />
                    <RNAnimated.View
                        style={[
                            styles.modalContent,
                            {
                                transform: [{
                                    translateY: slideAnim.interpolate({
                                        inputRange: [0, 1],
                                        outputRange: [600, 0],
                                    })
                                }]
                            }
                        ]}
                    >
                        <View style={styles.modalContentWrapper}>
                            <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                            <ScrollView style={styles.modalScrollView} contentContainerStyle={styles.modalScrollContent}>
                                <View style={styles.modalHeader}>
                                    <Text style={styles.modalTitle}>Choose Avatar</Text>
                                    <Pressable onPress={hideModal} style={styles.modalClose}>
                                        <MaterialIcons name="close" size={24} color="rgba(255,255,255,0.5)" />
                                    </Pressable>
                                </View>

                                {/* Photo Options */}
                                <View style={styles.photoOptionsContainer}>
                                    <Pressable style={styles.modalOption} onPress={() => { hideModal(); setTimeout(handleTakePhoto, 300); }}>
                                        <MaterialIcons name="camera-alt" size={24} color="#ffffff" />
                                        <Text style={styles.modalOptionText}>Take photo</Text>
                                    </Pressable>

                                    <Pressable style={styles.modalOption} onPress={() => { hideModal(); setTimeout(handleChoosePhoto, 300); }}>
                                        <MaterialIcons name="photo-library" size={24} color="#ffffff" />
                                        <Text style={styles.modalOptionText}>Choose from gallery</Text>
                                    </Pressable>

                                    {avatar && (
                                        <Pressable style={styles.modalOption} onPress={handleDeletePhoto}>
                                            <MaterialIcons name="delete" size={24} color="#ef4444" />
                                            <Text style={[styles.modalOptionText, { color: '#ef4444' }]}>Remove photo</Text>
                                        </Pressable>
                                    )}
                                </View>

                                <View style={styles.separator} />

                                <Pressable style={styles.modalOption} onPress={hideModal}>
                                    <Text style={[styles.modalOptionText, { textAlign: 'center', width: '100%', opacity: 0.7 }]}>Cancel</Text>
                                </Pressable>
                            </ScrollView>
                        </View>
                    </RNAnimated.View>
                </View>
            </Modal>
            <CountryPicker
                visible={countryModal}
                onClose={() => setCountryModal(false)}
                onSelect={async (c) => {
                    setCountry(c);
                    try {
                        await updateProfile({ country: c.name, countryCode: c.dialCode });
                    } catch (e) {
                        console.error('Failed to update country:', e);
                    }
                }}
                selectedCountry={country?.name}
                themeColor={activeTheme.primary}
            />
        </Animated.View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    backdrop: {
        backgroundColor: '#000000',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 54,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    backButton: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitle: {
        color: '#ffffff',
        fontSize: 18,
        fontWeight: '600',
    },
    placeholder: {
        width: 40,
    },
    scrollView: {
        flex: 1,
    },
    shellPlaceholder: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: 40,
    },
    heroMorphShell: {
        position: 'absolute',
        overflow: 'hidden',
        backgroundColor: '#1a1a1a',
        zIndex: 20,
    },
    heroMorphImageWrapper: {
        position: 'absolute',
        left: 0,
        right: 0,
        overflow: 'hidden',
    },
    heroMorphImage: {
        width: '100%',
        height: '100%',
    },
    avatarSection: {
        alignItems: 'center',
        paddingVertical: 32,
    },
    avatarContainer: {
        position: 'relative',
        width: 180,
        height: 180,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarPressable: {
        width: 180,
        height: 180,
        borderRadius: 90,
        overflow: 'hidden',
        position: 'relative',
    },
    avatarImage: {
        width: '100%',
        height: '100%',
        position: 'absolute',
    },
    avatarGlassBorder: {
        position: 'absolute',
        top: -10,
        left: -10,
        right: -10,
        bottom: -10,
        borderRadius: 100,
        borderWidth: 1.5,
        borderColor: 'rgba(255, 255, 255, 0.1)',
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
    },
    editButton: {
        marginTop: 12,
        fontSize: 16,
        fontWeight: '600',
    },
    section: {
        marginBottom: 12,
    },
    sectionLabel: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 13,
        fontWeight: '600',
        paddingHorizontal: 20,
        marginBottom: 6,
    },
    settingsGroup: {
        marginHorizontal: 16,
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    settingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
    },
    settingContent: {
        flex: 1,
    },
    settingLabel: {
        color: 'rgba(255,255,255,0.7)',
        fontSize: 11,
        marginBottom: 2,
    },
    settingValue: {
        color: '#ffffff',
        fontSize: 16,
    },
    editRow: {
        padding: 12,
    },
    editInput: {
        color: '#ffffff',
        fontSize: 16,
        padding: 10,
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderRadius: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.25)',
    },
    inputPrefixWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.12)',
        borderRadius: 12,
        paddingLeft: 12,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.25)',
    },
    inputPrefix: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 16,
        marginRight: -4,
    },
    editActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 12,
    },
    cancelBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    saveBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Full image modal
    fullImageModal: {
        flex: 1,
        backgroundColor: '#000000',
    },
    fullImageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: 54,
        paddingHorizontal: 16,
        paddingBottom: 16,
    },
    closeBtn: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    fullImageTitle: {
        color: '#ffffff',
        fontSize: 18,
        fontWeight: '600',
    },
    fullImageActions: {
        flexDirection: 'row',
        gap: 16,
    },
    editIconBtn: {
        width: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    fullImageContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullImage: {
        // Dynamic styles moved to inline or component
    },
    // Edit photo modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    modalContent: {
        width: '100%',
        backgroundColor: 'transparent',
        borderTopLeftRadius: 32,
        borderTopRightRadius: 32,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        minHeight: 280,
    },
    modalContentWrapper: {
        flex: 1,
        paddingBottom: 40,
        paddingTop: 10,
    },
    modalScrollView: {
        width: '100%',
    },
    modalScrollContent: {
        paddingBottom: 20,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.1)',
    },
    modalTitle: {
        color: '#ffffff',
        fontSize: 18,
        fontWeight: '600',
    },
    modalClose: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: 'rgba(255,255,255,0.1)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    modalOption: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 16,
        padding: 16,
        paddingHorizontal: 20,
    },
    modalOptionText: {
        color: '#ffffff',
        fontSize: 16,
    },
    separator: {
        height: 1,
        backgroundColor: 'rgba(255,255,255,0.1)',
        marginVertical: 8,
    },
    avatarPreviewContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 20,
        minHeight: 250,
    },
    avatarPreview: {
        width: 200,
        height: 250,
    },
    photoOptionsContainer: {
        paddingVertical: 10,
    },
});
