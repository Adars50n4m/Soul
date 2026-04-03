import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { styled } from 'nativewind';

const StyledView = styled(View);

export const SoulLogo = ({ className, width = 160, height = 160 }: { className?: string; width?: number; height?: number }) => (
    <StyledView 
        className={className} 
        style={{ 
            width, 
            height, 
            justifyContent: 'center', 
            alignItems: 'center',
            borderRadius: width / 2,
            overflow: 'hidden'
        }}
    >
        <Image
            source={require('../assets/images/logo.jpg')}
            style={{
                width: '100%',
                height: '100%',
            }}
            resizeMode="cover"
        />
    </StyledView>
);
