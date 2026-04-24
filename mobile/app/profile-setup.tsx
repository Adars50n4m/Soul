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
  ActivityIndicator,
  StatusBar,
  Modal,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather, MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { authService } from '../services/AuthService';
import { useApp } from '../context/AppContext';
import { CountryPicker } from '../components/CountryPicker';
import { Country } from '../constants/Countries';
import { GlassView } from '../components/ui/GlassView';

export default function ProfileSetupScreen() {
  const router = useRouter();
  const { username, password } = useLocalSearchParams<{ username: string; password: string }>();
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
        <GlassView intensity={Platform.OS === 'ios' ? 80 : 60} tint="dark" style={styles.card}>
          <View style={styles.stepPill}>
            <Text style={[styles.stepPillText, { color: themeAccent }]}>Step 2 of 2</Text>
          </View>

          <View style={styles.header}>
            <Text style={styles.title}>Set up your profile</Text>
            <Text style={styles.subtitle}>Add the basics so your Soul feels personal from the first message.</Text>
          </View>

          <View style={styles.progressRow}>
            <View style={[styles.progressSegment, styles.progressSegmentDone, { backgroundColor: themeAccent }]} />
            <View style={[styles.progressSegment, { backgroundColor: themeAccent }]} />
          </View>

        {/* Avatar picker */}
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

        <View style={styles.profilePreviewCard}>
          <View style={[styles.previewAvatarLarge, { borderColor: themeAccent }]}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.previewAvatarLargeImg} />
            ) : (
              <Text style={[styles.previewInitialsLarge, { color: themeAccent }]}>{initials || '?'}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.previewEyebrow}>Preview</Text>
            <Text style={styles.previewName}>{displayName.trim() || 'Your Display Name'}</Text>
            <Text style={styles.previewUsername}>@{username}</Text>
            <Text style={styles.previewMeta}>{country ? `${country.flag} ${country.name}` : 'Add your country for a more complete profile'}</Text>
          </View>
        </View>

        {/* Display Name */}
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

        {/* Country Picker */}
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
            ? <ActivityIndicator color="#0A0A0F" size="small" />
            : <Text style={styles.finishBtnText}>Finish setup</Text>
          }
        </TouchableOpacity>

        <Text style={styles.footerNote}>
          You can always update your photo, display name, and country later from profile settings.
        </Text>
        </GlassView>
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
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#BC002A';
const BG     = '#000000';
const BORDER = '#252535';

const styles = StyleSheet.create({
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
  scrollContent: { paddingHorizontal: 24, paddingTop: 44, paddingBottom: 40, alignItems: 'center' },
  card: {
    width: '100%',
    backgroundColor: 'rgba(26, 26, 28, 0.40)',
    borderRadius: 36,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  stepPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginBottom: 14,
  },
  stepPillText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  progressRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 22,
  },
  progressSegment: {
    flex: 1,
    height: 6,
    borderRadius: 999,
  },
  progressSegmentDone: {
    opacity: 0.45,
  },
  header: { width: '100%', marginBottom: 18 },
  title: { fontSize: 32, fontWeight: '900', color: '#E8E8F0', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#888899', lineHeight: 20, textAlign: 'center' },
  avatarSection: { alignItems: 'center', marginBottom: 24 },
  avatarTouchable: { position: 'relative', marginBottom: 10 },
  avatarImage: { width: 118, height: 118, borderRadius: 59, borderWidth: 3 },
  avatarPlaceholder: {
    width: 118, height: 118, borderRadius: 59, backgroundColor: '#1C1408',
    borderWidth: 2, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitials: { fontSize: 36, fontWeight: '700' },
  cameraOverlay: {
    position: 'absolute', bottom: 4, right: 4, width: 34, height: 34,
    borderRadius: 17, alignItems: 'center', justifyContent: 'center',
  },
  avatarTitle: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 4 },
  avatarHint: { color: '#888899', fontSize: 13, marginBottom: 4, textAlign: 'center', lineHeight: 18 },
  removePhoto: { color: '#FF6B6B', fontSize: 13, marginTop: 4 },
  fieldGroup: { width: '100%', marginBottom: 24 },
  label: { color: '#AAAABC', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#13131C',
    borderRadius: 16, borderWidth: 1.5, borderColor: BORDER, paddingHorizontal: 16, height: 58,
  },
  fieldIcon: { fontSize: 16, marginRight: 10 },
  inputIcon: { marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 16 },
  charCount: { color: '#444455', fontSize: 12 },
  fieldNote: { color: '#555566', fontSize: 12, marginTop: 6, marginLeft: 4, lineHeight: 17 },
  profilePreviewCard: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)', borderRadius: 20, padding: 16,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginBottom: 26, gap: 14,
  },
  previewAvatarLarge: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: '#1C1408',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    borderWidth: 1.5,
  },
  previewAvatarLargeImg: { width: 64, height: 64 },
  previewInitialsLarge: { fontSize: 22, fontWeight: '800' },
  previewEyebrow: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  previewName: { fontSize: 16, fontWeight: '600', color: '#E8E8F0', marginBottom: 2 },
  previewUsername: { fontSize: 13, color: '#888899' },
  previewMeta: { fontSize: 12, color: '#77778A', marginTop: 4 },
  errorText: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', marginBottom: 16, width: '100%' },
  finishBtn: { width: '100%', borderRadius: 16, height: 56, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { opacity: 0.6 },
  finishBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '800' },
  footerNote: {
    color: '#767688',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 14,
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
