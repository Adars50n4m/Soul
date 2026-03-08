import React from 'react';
import { StyleSheet, Text, View, ViewStyle, TextStyle } from 'react-native';
import { Accordion as BaseAccordion } from '@animatereactnative/accordion';
import { Feather } from '@expo/vector-icons';

interface CustomAccordionProps {
  title: string;
  preview?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  containerStyle?: ViewStyle;
  titleStyle?: TextStyle;
  iconColor?: string;
}

/**
 * Global CustomAccordion Component
 * 
 * A standardized, branded accordion for use across the SoulSync app.
 * Wraps @animatereactnative/accordion with custom styling.
 */
export const CustomAccordion = ({
  title,
  preview,
  children,
  footer,
  containerStyle,
  titleStyle,
  iconColor = '#EC4899', // SoulSync Pink
}: CustomAccordionProps) => {
  return (
    <BaseAccordion.Accordion 
      style={[styles.container, containerStyle]}
    >
      <BaseAccordion.Header style={styles.header}>
        <Text style={[styles.title, titleStyle]}>{title}</Text>
        <BaseAccordion.HeaderIcon>
          <Feather name="chevron-down" size={20} color={iconColor} />
        </BaseAccordion.HeaderIcon>
      </BaseAccordion.Header>

      {preview && (
        <BaseAccordion.Collapsed>
          <Text style={styles.previewText}>{preview}</Text>
        </BaseAccordion.Collapsed>
      )}

      <BaseAccordion.Expanded>
        <View style={styles.content}>
          {children}
        </View>
      </BaseAccordion.Expanded>

      {footer && (
        <BaseAccordion.Always>
          <View style={styles.footer}>
            {footer}
          </View>
        </BaseAccordion.Always>
      )}
    </BaseAccordion.Accordion>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 16,
    marginVertical: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  header: {
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  previewText: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    fontSize: 14,
    color: '#9CA3AF',
  },
  content: {
    padding: 16,
    paddingTop: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  footer: {
    padding: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
});

export default CustomAccordion;
