import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TextInput,
  FlatList,
  TouchableOpacity,
  Pressable,
  Platform,
} from 'react-native';
import { GlassView } from './ui/GlassView';
import { MaterialIcons } from '@expo/vector-icons';
import { COUNTRIES, Country } from '../constants/Countries';

interface CountryPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (country: Country) => void;
  selectedCountry?: string;
  themeColor?: string;
}

export const CountryPicker: React.FC<CountryPickerProps> = ({
  visible,
  onClose,
  onSelect,
  selectedCountry,
  themeColor = '#BC002A', // Default midnight red
}) => {
  const [search, setSearch] = useState('');

  const filteredCountries = useMemo(() => {
    if (!search.trim()) return COUNTRIES;
    const lowerSearch = search.toLowerCase();
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(lowerSearch) ||
        c.dialCode.includes(lowerSearch)
    );
  }, [search]);

  const renderItem = ({ item }: { item: Country }) => {
    const isSelected = selectedCountry === item.name;

    return (
      <TouchableOpacity
        style={[
          styles.countryItem,
          isSelected && { backgroundColor: 'rgba(255,255,255,0.08)' },
        ]}
        onPress={() => {
          onSelect(item);
          onClose();
          setSearch('');
        }}
        activeOpacity={0.7}
      >
        <Text style={styles.flag}>{item.flag}</Text>
        <View style={styles.countryInfo}>
          <Text style={[styles.countryName, isSelected && { color: themeColor }]}>
            {item.name}
          </Text>
          <Text style={styles.dialCode}>{item.dialCode}</Text>
        </View>
        {isSelected && (
          <MaterialIcons name="check" size={20} color={themeColor} />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.container}>
          <GlassView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
          
          <View style={styles.header}>
            <View style={styles.handle} />
            <Text style={styles.title}>Select Country</Text>
            
            <View style={styles.searchContainer}>
              <MaterialIcons name="search" size={20} color="rgba(255,255,255,0.4)" />
              <TextInput
                style={styles.searchInput}
                placeholder="Search country or code..."
                placeholderTextColor="rgba(255,255,255,0.4)"
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')}>
                  <MaterialIcons name="close" size={18} color="rgba(255,255,255,0.4)" />
                </TouchableOpacity>
              )}
            </View>
          </View>

          <FlatList
            data={filteredCountries}
            renderItem={renderItem}
            keyExtractor={(item) => item.code}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            windowSize={10}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  container: {
    height: '80%',
    backgroundColor: 'rgba(20,20,25,0.8)',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  header: {
    padding: 20,
    paddingTop: 12,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  handle: {
    width: 40,
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#E8E8F0',
    marginBottom: 16,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
    width: '100%',
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    marginLeft: 8,
  },
  listContent: {
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  flag: {
    fontSize: 26,
    marginRight: 16,
  },
  countryInfo: {
    flex: 1,
  },
  countryName: {
    fontSize: 16,
    color: '#E8E8F0',
    fontWeight: '500',
    marginBottom: 2,
  },
  dialCode: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.4)',
  },
});
