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
import * as ImagePicker from 'expo-image-picker';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { authService } from '../services/AuthService';

export default function ProfileSetupScreen() {
  const router = useRouter();
  const { username, password } = useLocalSearchParams<{ username: string; password: string }>();

  const [displayName,  setDisplayName]  = useState('');
  const [avatarUri,    setAvatarUri]    = useState<string | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [pickerModal,  setPickerModal]  = useState(false);

  const openCamera = async () => {
    setPickerModal(false);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera permission is required to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
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
    });

    setLoading(false);

    if (!result.success) {
      setError(result.error ?? 'Could not save profile. Please try again.');
      return;
    }

    router.replace('/(tabs)');
  };

  const initials = displayName.trim()
    ? displayName.trim().split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
    : (username ?? '').slice(0, 2).toUpperCase();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0A0A0F" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.step}>Step 2 of 2</Text>
          <Text style={styles.title}>Set up your profile</Text>
          <Text style={styles.subtitle}>Let people know who you are</Text>
        </View>

        {/* Avatar picker */}
        <View style={styles.avatarSection}>
          <TouchableOpacity
            style={styles.avatarTouchable}
            onPress={() => setPickerModal(true)}
            activeOpacity={0.85}
          >
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitials}>{initials || '?'}</Text>
              </View>
            )}
            <View style={styles.cameraOverlay}>
              <Text style={styles.cameraIcon}>📷</Text>
            </View>
          </TouchableOpacity>
          <Text style={styles.avatarHint}>
            {avatarUri ? 'Tap to change photo' : 'Tap to add photo (optional)'}
          </Text>
          {avatarUri && (
            <TouchableOpacity onPress={() => setAvatarUri(null)}>
              <Text style={styles.removePhoto}>Remove photo</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Display Name */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Display Name</Text>
          <View style={styles.inputWrapper}>
            <Text style={styles.fieldIcon}>✨</Text>
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

        {/* Preview */}
        <View style={styles.previewCard}>
          <View style={styles.previewAvatar}>
            {avatarUri
              ? <Image source={{ uri: avatarUri }} style={styles.previewAvatarImg} />
              : <Text style={styles.previewInitials}>{initials || '?'}</Text>
            }
          </View>
          <View>
            <Text style={styles.previewName}>
              {displayName.trim() || 'Your Name'}
            </Text>
            <Text style={styles.previewUsername}>@{username}</Text>
          </View>
        </View>

        {!!error && <Text style={styles.errorText}>{error}</Text>}

        <TouchableOpacity
          style={[styles.finishBtn, loading && styles.btnDisabled]}
          onPress={handleFinish}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#0A0A0F" size="small" />
            : <Text style={styles.finishBtnText}>Finish Setup 🎉</Text>
          }
        </TouchableOpacity>
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
    </KeyboardAvoidingView>
  );
}

const AMBER  = '#F5A623';
const BG     = '#0A0A0F';
const BORDER = '#252535';

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  scrollContent: { paddingHorizontal: 24, paddingTop: 60, paddingBottom: 40, alignItems: 'center' },
  header: { width: '100%', marginBottom: 36 },
  step: { color: AMBER, fontSize: 12, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  title: { fontSize: 26, fontWeight: '700', color: '#E8E8F0', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888899' },
  avatarSection: { alignItems: 'center', marginBottom: 36 },
  avatarTouchable: { position: 'relative', marginBottom: 10 },
  avatarImage: { width: 110, height: 110, borderRadius: 55, borderWidth: 3, borderColor: AMBER },
  avatarPlaceholder: {
    width: 110, height: 110, borderRadius: 55, backgroundColor: '#1C1408',
    borderWidth: 2, borderColor: AMBER, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarInitials: { fontSize: 36, fontWeight: '700', color: AMBER },
  cameraOverlay: {
    position: 'absolute', bottom: 2, right: 2, width: 32, height: 32,
    borderRadius: 16, backgroundColor: AMBER, alignItems: 'center', justifyContent: 'center',
  },
  cameraIcon: { fontSize: 14 },
  avatarHint: { color: '#888899', fontSize: 13, marginBottom: 4 },
  removePhoto: { color: '#FF6B6B', fontSize: 13, marginTop: 4 },
  fieldGroup: { width: '100%', marginBottom: 24 },
  label: { color: '#AAAABC', fontSize: 13, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase' },
  inputWrapper: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#13131C',
    borderRadius: 12, borderWidth: 1.5, borderColor: BORDER, paddingHorizontal: 14, height: 52,
  },
  fieldIcon: { fontSize: 16, marginRight: 10 },
  input: { flex: 1, color: '#E8E8F0', fontSize: 16 },
  charCount: { color: '#444455', fontSize: 12 },
  fieldNote: { color: '#555566', fontSize: 12, marginTop: 6, marginLeft: 4, lineHeight: 17 },
  previewCard: {
    width: '100%', flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#13131C', borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: BORDER, marginBottom: 28, gap: 12,
  },
  previewAvatar: {
    width: 50, height: 50, borderRadius: 25, backgroundColor: '#1C1408',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  previewAvatarImg: { width: 50, height: 50 },
  previewInitials: { fontSize: 18, fontWeight: '700', color: AMBER },
  previewName: { fontSize: 16, fontWeight: '600', color: '#E8E8F0', marginBottom: 2 },
  previewUsername: { fontSize: 13, color: '#888899' },
  errorText: { color: '#FF6B6B', fontSize: 14, textAlign: 'center', marginBottom: 16, width: '100%' },
  finishBtn: { width: '100%', backgroundColor: AMBER, borderRadius: 12, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnDisabled: { opacity: 0.6 },
  finishBtnText: { color: '#0A0A0F', fontSize: 16, fontWeight: '700' },
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
