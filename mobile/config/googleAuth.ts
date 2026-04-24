import Constants from 'expo-constants';

/**
 * Google OAuth client IDs for authentication.
 * 
 * In production/dev-client, these should be set in your .env file:
 * EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...
 * EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=...
 */

const getEnvVar = (name: string, fallback: string): string => {
  return process.env[name] || Constants.expoConfig?.extra?.[name] || fallback;
};

export const GOOGLE_WEB_CLIENT_ID = getEnvVar(
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID', 
  'REPLACE_WITH_WEB_CLIENT_ID.apps.googleusercontent.com'
);

export const GOOGLE_IOS_CLIENT_ID = getEnvVar(
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID', 
  'REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com'
);
