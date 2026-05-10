// mobile/app/profile-setup.tsx
// Adapted from reference ProfileSetupScreen.tsx for Expo Router
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  Modal,
  SafeAreaView,
} from 'react-native';
import { SoulLoader } from '../components/ui/SoulLoader';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Animated from 'react-native-reanimated';
import * as ImagePicker from 'expo-image-picker';
import { authService } from '../services/AuthService';
import { useApp } from '../context/AppContext';
import { CountryPicker } from '../components/CountryPicker';
import { Country } from '../constants/Countries';
import { GlassView } from '../components/ui/GlassView';

export default function ProfileSetupScreen() {
  const router = useRouter();
  const { username, password, oauthMode } = useLocalSearchParams<{ username: string; password: string; oauthMode?: string }>();
  const { activeTheme, setSession } = useApp();
  const themeAccent = activeTheme.primary;


  const [displayName,  setDisplayName]  = useState('');
  const [avatarUri,    setAvatarUri]    = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [pickerModal,  setPickerModal]  = useState(false);
  const [countryModal, setCountryModal] = useState(false);
  const [country,      setCountry]      = useState<Country | null>(null);

  const openCamera = async () => {
    setPickerModal(false);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera permission is required to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'] as ImagePicker.MediaType[],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled) {
      setAvatarUri(result.assets[0].uri);
    }
  };

  const openGallery = async () => {
    setPickerModal(false);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('Gallery permission is required to choose a photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as ImagePicker.MediaType[],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      legacy: true,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) {
      setAvatarUri(result.assets[0].uri);
    }
  };

  const handleBack = () => {
    router.replace({
      pathname: '/username-setup',
      params: {
        username: username ?? '',
        password: password ?? '',
        oauthMode: oauthMode ?? 'false',
      },
    });
  };

  const handleFinish = async () => {
    setError('');

    if (!displayName.trim()) {
      setError('Please enter your display name.');
      return;
    }
    if (displayName.trim().length < 2) {
      setError('Display name must be at least 2 characters.');
      return;
    }

    setLoading(true);

    const result = await authService.completeProfileSetup({
      username: username ?? '',
      password: password ?? '',
      displayName: displayName.trim(),
      avatarLocalUri: avatarUri ?? undefined,
      country: country?.name,
      countryCode: country?.dialCode,
    });

    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Could not save profile. Please try again.');
      return;
    }

    if (result.user?.id) {
      await setSession(result.user.id);
    }

    router.replace('/(tabs)');
  };

  const initials = displayName.trim()
    ? displayName.trim().split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : (username ?? '').slice(0, 2).toUpperCase();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: activeTheme.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <View style={styles.bgOrbOne} />
      <View style={styles.bgOrbTwo} />
      <LinearGradient
        colors={['rgba(188,0,42,0.16)', 'rgba(188,0,42,0.03)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bgGlow}
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroBlock}>
          <View style={styles.stepPill}>
            <Text style={[styles.stepPillText, { color: themeAccent }]}>STEP 2 / 2</Text>
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>Set up your profile</Text>
            <Text style={styles.subtitle}>Add the basics so your Soul feels personal from the first message.</Text>
          </View>
        </View>

        <Animated.View sharedTransitionTag="onboarding-setup-card" style={styles.sharedCardWrap}>
        <GlassView intensity={Platform.OS === 'ios' ? 80 : 60} tint="dark" style={styles.card}>
          <View style={styles.cardTopRow}>
            <TouchableOpacity onPress={handleBack} style={styles.backButton} activeOpacity={0.85}>
              <Feather name="arrow-left" size={18} color={themeAccent} />
              <Text style={[styles.backButtonText, { color: themeAccent }]}>Back</Text>
            </TouchableOpacity>

            <View style={styles.progressRail}>
              <View style={[styles.progressFill, { backgroundColor: themeAccent }]} />
            </View>
          </View>

          <View style={styles.avatarSection}>
            <TouchableOpacity
              style={styles.avatarTouchable}
              onPress={() => setPickerModal(true)}
              activeOpacity={0.85}
            >
              {avatarUri ? (
                <Image source={{ uri: avatarUri }} style={[styles.avatarImage, { borderColor: themeAccent }]} />
              ) : (
                <View style={[styles.avatarPlaceholder, { borderColor: themeAccent }]}>
                  <Text style={[styles.avatarInitials, { color: themeAccent }]}>
                    {initials || '?'}
                  </Text>
                </View>
              )}
              <View style={[styles.cameraOverlay, { backgroundColor: themeAccent }]}>
                <Feather name="camera" size={16} color="#fff" />
              </View>
            </TouchableOpacity>
            <Text style={styles.avatarTitle}>Choose your profile vibe</Text>
            <Text style={styles.avatarHint}>
              {avatarUri ? 'Tap to change photo' : 'Tap to add photo. You can skip this for now.'}
            </Text>
            {avatarUri && (
              <TouchableOpacity onPress={() => setAvatarUri(null)}>
                <Text style={styles.removePhoto}>Remove photo</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Display Name</Text>
            <View style={styles.inputWrapper}>
              <Feather name="type" size={16} color="#8E8EA0" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="How should we call you?"
                placeholderTextColor="#555566"
                value={displayName}
                onChangeText={(t) => { setDisplayName(t); setError(''); }}
                autoCapitalize="words"
                autoCorrect={false}
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={handleFinish}
              />
              <Text style={styles.charCount}>{displayName.length}/40</Text>
            </View>
            <Text style={styles.fieldNote}>
              This is shown to others — can be your real name or a nickname
            </Text>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Country</Text>
            <TouchableOpacity 
              style={styles.inputWrapper}
              onPress={() => setCountryModal(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.fieldIcon}>{country ? country.flag : '🌍'}</Text>
              <Text style={[styles.input, !country && { color: '#555566' }]}>
                {country ? `${country.name} (${country.dialCode})` : 'Choose your country'}
              </Text>
              <MaterialIcons name="keyboard-arrow-down" size={20} color="#8E8EA0" />
            </TouchableOpacity>
            <Text style={styles.fieldNote}>
              Used to show your country in your profile and for connectivity
            </Text>
          </View>

          {!!error && <Text style={styles.errorText}>{error}</Text>}

          <TouchableOpacity
            style={[styles.finishBtn, { backgroundColor: themeAccent }, loading && styles.btnDisabled]}
            onPress={handleFinish}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <SoulLoader size={40} />
              : <Text style={styles.finishBtnText}>Finish setup</Text>
            }
          </TouchableOpacity>

          <Text style={styles.footerNote}>
            You can always update your photo, display name, and country later from profile settings.
          </Text>
        </GlassView>
        </Animated.View>
      </ScrollView>

      {/* Image picker modal */}
      <Modal
        visible={pickerModal}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setPickerModal(false)}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Choose Photo</Text>

            <TouchableOpacity style={styles.modalOption} onPress={openCamera}>
              <Text style={styles.modalOptionIcon}>📷</Text>
              <Text style={styles.modalOptionText}>Take a photo</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.modalOption} onPress={openGallery}>
              <Text style={styles.modalOptionIcon}>🖼️</Text>
              <Text style={styles.modalOptionText}>Choose from gallery</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => setPickerModal(false)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <CountryPicker
        visible={countryModal}
        onClose={() => setCountryModal(false)}
        onSelect={(c) => {
            setCountry(c);
            setError('');
        }}
        selectedCountry={country?.name}
        themeColor={themeAccent}
      />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#BC002A';
const BG     = '#000000';
const BORDER = '#252535';

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  root: { flex: 1, backgroundColor: BG },
  bgOrbOne: {
    position: 'absolute',
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: 'rgba(188,0,42,0.08)',
    top: -90,
    right: -150,
  },
  bgOrbTwo: {
    position: 'absolute',
    width: 430,
    height: 430,
    borderRadius: 215,
    backgroundColor: 'rgba(255,255,255,0.03)',
    bottom: -140,
    left: -200,
  },
  bgGlow: {
    position: 'absolute',
    top: 120,
    left: 0,
    right: 0,
    height: 280,
  },
  scrollContent: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, alignItems: 'center' },
  heroBlock: { width: '100%', alignItems: 'center', marginBottom: 14, paddingHorizontal: 8 },
  card: {
    width: '100%',
    backgroundColor: 'rgba(26, 26, 28, 0.40)',
    borderRadius: 36,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  sharedCardWrap: {
    width: '100%',
  },
  stepPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 10,
  },
  stepPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  header: { width: '100%' },
  title: { fontSize: 26, fontWeight: '900', color: '#E8E8F0', marginBottom: 6, textAlign: 'center', lineHeight: 29 },
  subtitle: { fontSize: 12, color: '#888899', lineHeight: 18, textAlign: 'center' },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
  },
  backButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  progressRail: {
    flex: 1,
    height: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  progressFill: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
  },
  avatarSection: { alignItems: 'center', marginBottom: 16 },
  avatarTouchable: { position: 'relative', marginBottom: 10 },
  avatarImage: { width: 92, height: 92, borderRadius: 46, borderWidth: 2.5 },
  avatarPlaceholder: {
    width: 92, height: 92, borderRadius: 46, backgroundColor: '#1C1408',
    borderWidth: 2, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitials: { fontSize: 28, fontWeight: '700' },
  cameraOverlay: {
    position: 'absolute', bottom: 2, right: 2, width: 30, height: 30,
    borderRadius: 15, alignItems: 'center', justifyContent: 'center',
  },
  avatarTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 3 },
  avatarHint: { color: '#888899', fontSize: 12, marginBottom: 3, textAlign: 'center', lineHeight: 17 },
  removePhoto: { color: '#FF6B6B', fontSize: 12, marginTop: 2 },
  fieldGroup: { width: '100%', marginBottom: 16 },
  label: { color: '#AAAABC', fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 6, textTransform: 'uppercase' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#13131C',
    borderRadius: 16, borderWidth: 1.5, borderColor: BORDER, paddingHorizontal: 14, height: 54,
  },
  fieldIcon: { fontSize: 16, marginRight: 10 },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 15 },
  charCount: { color: '#444455', fontSize: 12 },
  fieldNote: { color: '#555566', fontSize: 11, marginTop: 5, marginLeft: 4, lineHeight: 16 },
  errorText: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', marginBottom: 16, width: '100%' },
  finishBtn: { width: '100%', borderRadius: 16, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { opacity: 0.6 },
  finishBtnText: { color: '#0A0A0F', fontSize: 15, fontWeight: '800' },
  footerNote: {
    color: '#767688',
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: 10,
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#13131C', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  modalHandle: { width: 40, height: 4, backgroundColor: '#333344', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: '600', color: '#E8E8F0', textAlign: 'center', marginBottom: 24 },
  modalOption: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: BORDER, gap: 14 },
  modalOptionIcon: { fontSize: 22 },
  modalOptionText: { fontSize: 16, color: '#E8E8F0', fontWeight: '500' },
  modalCancel: { marginTop: 16, alignItems: 'center', paddingVertical: 12 },
  modalCancelText: { color: '#FF6B6B', fontSize: 16, fontWeight: '500' },
});
