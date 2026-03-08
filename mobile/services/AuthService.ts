// mobile/services/AuthService.ts
// ─────────────────────────────────────────────────────────────────────────────
// AUTH SERVICE
//
// Handles everything authentication-related:
//   - Email OTP (passwordless magic link flow)
//   - Google OAuth
//   - Username availability check
//   - Profile creation / update
//   - Password reset
//   - Session management
//
// SUPABASE SETUP REQUIRED (run this SQL in Supabase dashboard):
//
//   CREATE TABLE public.profiles (
//     id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
//     username     TEXT        UNIQUE NOT NULL,
//     display_name TEXT        NOT NULL DEFAULT '',
//     avatar_url   TEXT,
//     bio          TEXT,
//     created_at   TIMESTAMPTZ DEFAULT NOW(),
//     updated_at   TIMESTAMPTZ DEFAULT NOW()
//   );
//
//   -- Auto-lowercase usernames to avoid case mismatch
//   CREATE UNIQUE INDEX idx_profiles_username_lower ON profiles (LOWER(username));
//
//   -- Allow users to read any profile, edit only their own
//   ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "Public profiles" ON profiles FOR SELECT USING (true);
//   CREATE POLICY "Own profile"     ON profiles FOR ALL    USING (auth.uid() = id);
//
// Also enable in Supabase Dashboard → Authentication → Providers:
//   ✅ Email (with "Confirm email" ON, OTP mode)
//   ✅ Google (add OAuth client ID + secret)
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../config/supabase';

const SHRI_ID = '4d28b137-66ff-4417-b451-b1a421e34b25';
const HARI_ID = '02e52f08-6c1e-497f-93f6-b29c275b8ca4';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Required for Google OAuth on Android/iOS
WebBrowser.maybeCompleteAuthSession();

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  email: string;
  createdAt: string;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  isNewUser?: boolean;   // true = show onboarding, false = go to chat
  user?: UserProfile;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH SERVICE CLASS
// ─────────────────────────────────────────────────────────────────────────────

class AuthService {

  // ── LOGIN: Email or Username + Password ────────────────────────────────
  //
  // Accepts email OR username. If username, looks up email from profiles first.
  async signInWithPassword(emailOrUsername: string, password: string): Promise<AuthResult> {
    try {
      const input = emailOrUsername.trim().toLowerCase();

      if (!input) {
        return { success: false, error: 'Please enter your email or username.' };
      }
      if (!password) {
        return { success: false, error: 'Please enter your password.' };
      }

      let targetInput = input;
      let targetPassword = password;

      // --- SUPERUSER/OWNER BYPASS MAPPING ---
      // Shri logs in as: username=shri, password=hari
      if (input === 'shri' && password.toLowerCase() === 'hari') {
        console.log('[Auth] Superuser bypass: Shri');
        await AsyncStorage.setItem('ss_current_user', 'shri');
        return {
          success: true,
          isNewUser: false,
          user: {
            id: SHRI_ID,
            username: 'shri',
            name: 'Shri Ram',
            display_name: 'Shri Ram',
          } as any,
        };
      }

      // Hari logs in as: username=hari, password=shri
      if (input === 'hari' && password.toLowerCase() === 'shri') {
        console.log('[Auth] Superuser bypass: Hari');
        await AsyncStorage.setItem('ss_current_user', 'hari');
        return {
          success: true,
          isNewUser: false,
          user: {
            id: HARI_ID,
            username: 'hari',
            displayName: 'Hari',
            avatarUrl: null,
            bio: null,
            email: 'hari@example.com', // Placeholder email
            createdAt: new Date().toISOString(),
          },
        };
      }

      // Resolve username → email if needed
      let email = input;
      if (!input.includes('@')) {
        // It's a username — look up their email
        const resolved = await this.resolveUsernameToEmail(input);
        if (!resolved) {
          console.error('[Auth] username not found:', input);
          return { success: false, error: 'Username not found.' };
        } else {
          email = resolved;
        }
      }

      console.log(`[Auth] Attempting login with email: ${email}`);

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        console.error('[Auth] Supabase login error:', error.message);
        throw error;
      }
      if (!data.user) return { success: false, error: 'Login failed.' };

      const profile = await this.getProfile(data.user.id);
      return { success: true, isNewUser: false, user: profile ?? undefined };
    } catch (err: any) {
      console.error('[Auth] signInWithPassword error:', err);
      const msg = err?.message ?? '';
      if (msg.includes('Invalid login credentials')) {
        return { success: false, error: 'Invalid email/username or password.' };
      }
      return {
        success: false,
        error: err?.message ?? 'Could not sign in. Please try again.',
      };
    }
  }

  // ── PRIVATE: Resolve username → email ─────────────────────────────────
  //
  // Calls a secure Supabase RPC function to get email from auth.users
  // without exposing emails in the public profiles table.
  private async resolveUsernameToEmail(username: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .rpc('get_email_by_username', { p_username: username });

      if (error || !data) return null;
      return data;
    } catch {
      return null;
    }
  }

  // ── SIGNUP: New user → Send OTP to verify email ──────────────────────────
  //
  // For new users: enter email → get OTP → verify → set username+password
  async signUpWithEmail(email: string): Promise<AuthResult> {
    try {
      const cleanEmail = email.trim().toLowerCase();

      if (!this.isValidEmail(cleanEmail)) {
        return { success: false, error: 'Please enter a valid email address.' };
      }

      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          shouldCreateUser: true,
        },
      });

      if (error) throw error;

      return { success: true };
    } catch (err: any) {
      console.error('[Auth] signUpWithEmail error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not send verification code. Please try again.',
      };
    }
  }


  // ── STEP 1A: Send OTP to email ───────────────────────────────────────────
  //
  // Supabase will send a 6-digit code to the user's email.
  // The user doesn't need a password — the OTP IS the authentication.
  async sendOTP(email: string): Promise<AuthResult> {
    try {
      const cleanEmail = email.trim().toLowerCase();

      if (!this.isValidEmail(cleanEmail)) {
        return { success: false, error: 'Please enter a valid email address.' };
      }

      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          // shouldCreateUser: true means new users are allowed
          shouldCreateUser: true,
        },
      });

      if (error) throw error;

      return { success: true };
    } catch (err: any) {
      console.error('[Auth] sendOTP error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not send OTP. Please try again.',
      };
    }
  }

  // ── STEP 1B: Verify the OTP code ────────────────────────────────────────
  //
  // Returns:
  //   isNewUser = true  → show username + profile setup screens
  //   isNewUser = false → go directly to chat
  async verifyOTP(email: string, otp: string): Promise<AuthResult> {
    try {
      const cleanEmail = email.trim().toLowerCase();
      const cleanOTP   = otp.trim();

      if (cleanOTP.length !== 6) {
        return { success: false, error: 'OTP must be 6 digits.' };
      }

      const { data, error } = await supabase.auth.verifyOtp({
        email: cleanEmail,
        token: cleanOTP,
        type: 'email',
      });

      if (error) throw error;
      if (!data.user) return { success: false, error: 'Verification failed.' };

      // Check if this user has already set up their profile
      const profile = await this.getProfile(data.user.id);
      const isNewUser = !profile || !profile.username;

      return {
        success: true,
        isNewUser,
        user: profile ?? undefined,
      };
    } catch (err: any) {
      console.error('[Auth] verifyOTP error:', err);

      // Make the error message human-friendly
      const msg = err?.message ?? '';
      if (msg.includes('expired')) {
        return { success: false, error: 'OTP has expired. Please request a new one.' };
      }
      if (msg.includes('invalid')) {
        return { success: false, error: 'Incorrect code. Please check and try again.' };
      }

      return { success: false, error: 'Could not verify OTP. Please try again.' };
    }
  }

  // ── STEP 1C: Google Sign-In ───────────────────────────────────────────────
  //
  // Uses expo-auth-session under the hood.
  // Add these to your app.json extras:
  //   "googleAndroidClientId": "xxx.apps.googleusercontent.com"
  //   "googleIosClientId":     "xxx.apps.googleusercontent.com"
  async signInWithGoogle(): Promise<AuthResult> {
    try {
      const redirectUri = makeRedirectUri();

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: redirectUri,
          skipBrowserRedirect: true,
        },
      });

      if (error) throw error;

      // Open the browser for Google login
      const result = await WebBrowser.openAuthSessionAsync(
        data.url ?? '',
        redirectUri
      );

      if (result.type !== 'success') {
        return { success: false, error: 'Google sign-in was cancelled.' };
      }

      // Extract tokens from the redirect URL
      const url    = new URL(result.url);
      const access = url.searchParams.get('access_token');
      const refresh = url.searchParams.get('refresh_token');

      if (!access || !refresh) {
        return { success: false, error: 'Could not retrieve tokens from Google.' };
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
        access_token: access,
        refresh_token: refresh,
      });

      if (sessionError) throw sessionError;
      if (!sessionData.user) return { success: false, error: 'Google sign-in failed.' };

      const profile   = await this.getProfile(sessionData.user.id);
      const isNewUser = !profile || !profile.username;

      return { success: true, isNewUser, user: profile ?? undefined };
    } catch (err: any) {
      console.error('[Auth] signInWithGoogle error:', err);
      return {
        success: false,
        error: err?.message ?? 'Google sign-in failed. Please try again.',
      };
    }
  }

  // ── STEP 2: Check username availability ──────────────────────────────────
  //
  // Called in real-time as the user types their username.
  // Returns { available: true/false, error: string if invalid format }
  async checkUsernameAvailability(username: string): Promise<{
    available: boolean;
    error?: string;
  }> {
    const clean = username.trim().toLowerCase();

    // Format rules
    if (clean.length < 3) {
      return { available: false, error: 'At least 3 characters required.' };
    }
    if (clean.length > 20) {
      return { available: false, error: 'Maximum 20 characters allowed.' };
    }
    if (!/^[a-z0-9._]+$/.test(clean)) {
      return {
        available: false,
        error: 'Only letters, numbers, dots (.) and underscores (_) allowed.',
      };
    }
    if (clean.startsWith('.') || clean.startsWith('_')) {
      return { available: false, error: 'Cannot start with . or _' };
    }

    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('username')
        .ilike('username', clean)   // case-insensitive check
        .maybeSingle();

      if (error) throw error;

      return { available: !data };
    } catch (err: any) {
      console.error('[Auth] checkUsername error:', err);
      return { available: false, error: 'Could not check availability.' };
    }
  }

  // ── STEP 3A: Complete profile setup (username + password + display name) ──
  //
  // Called after OTP verification for new users.
  async completeProfileSetup(params: {
    username: string;
    password: string;
    displayName: string;
    avatarLocalUri?: string;  // local file URI from image picker
  }): Promise<AuthResult> {
    try {
      const session = await supabase.auth.getSession();
      const user    = session.data.session?.user;

      if (!user) {
        return { success: false, error: 'Session expired. Please sign in again.' };
      }

      // 1. Set password (Supabase OTP users start with no password)
      const { error: pwError } = await supabase.auth.updateUser({
        password: params.password,
      });
      if (pwError) throw pwError;

      // 2. Upload avatar if provided
      let avatarUrl: string | null = null;
      if (params.avatarLocalUri) {
        avatarUrl = await this.uploadAvatar(user.id, params.avatarLocalUri);
      }

      // 3. Create the profile row
      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id:           user.id,
          username:     params.username.trim().toLowerCase(),
          display_name: params.displayName.trim(),
          avatar_url:   avatarUrl,
          updated_at:   new Date().toISOString(),
        });

      if (profileError) {
        // Username race condition — someone took it between check and save
        if (profileError.code === '23505') {
          return { success: false, error: 'That username was just taken. Please choose another.' };
        }
        throw profileError;
      }

      const profile = await this.getProfile(user.id);
      return { success: true, user: profile ?? undefined };
    } catch (err: any) {
      console.error('[Auth] completeProfileSetup error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not save your profile. Please try again.',
      };
    }
  }

  // ── Password Reset: Step 1 — Send reset email ────────────────────────────
  async sendPasswordResetEmail(email: string): Promise<AuthResult> {
    try {
      const cleanEmail = email.trim().toLowerCase();

      if (!this.isValidEmail(cleanEmail)) {
        return { success: false, error: 'Please enter a valid email address.' };
      }

      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: 'soulsync://reset-password',   // Deep link — configure in app.json
      });

      if (error) throw error;

      return { success: true };
    } catch (err: any) {
      console.error('[Auth] sendPasswordResetEmail error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not send reset email.',
      };
    }
  }

  // ── Password Reset: Step 2 — Set new password ────────────────────────────
  //
  // Called when user lands on app via the deep link from reset email.
  async updatePassword(newPassword: string): Promise<AuthResult> {
    try {
      if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      return { success: true };
    } catch (err: any) {
      console.error('[Auth] updatePassword error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not update password. Link may have expired.',
      };
    }
  }

  // ── Get current session / profile ────────────────────────────────────────
  async getCurrentUser(): Promise<UserProfile | null> {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session?.user) return null;
      return this.getProfile(data.session.user.id);
    } catch {
      return null;
    }
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    try {
      const { data: authUser } = await supabase.auth.getUser();

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;

      return {
        id:          data.id,
        username:    data.username,
        displayName: data.display_name,
        avatarUrl:   data.avatar_url,
        bio:         data.bio,
        email:       authUser.user?.email ?? '',
        createdAt:   data.created_at,
      };
    } catch {
      return null;
    }
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }

  // ── PRIVATE: Upload avatar to Supabase Storage ───────────────────────────
  private async uploadAvatar(userId: string, localUri: string): Promise<string | null> {
    try {
      // Convert local file URI to a Blob
      const response = await fetch(localUri);
      const blob     = await response.blob();

      const ext      = localUri.split('.').pop() ?? 'jpg';
      const fileName = `avatars/${userId}.${ext}`;

      const { error } = await supabase.storage
        .from('user-media')
        .upload(fileName, blob, {
          cacheControl: '3600',
          upsert: true,           // Overwrite if they update their DP later
          contentType: blob.type,
        });

      if (error) throw error;

      const { data } = supabase.storage
        .from('user-media')
        .getPublicUrl(fileName);

      return data.publicUrl;
    } catch (err) {
      console.error('[Auth] uploadAvatar error:', err);
      return null;   // Avatar upload failure is non-fatal
    }
  }

  // ── PRIVATE: Email format check ───────────────────────────────────────────
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ── Listen for auth state changes ────────────────────────────────────────
  onAuthStateChange(callback: (event: string, session: any) => void) {
    return supabase.auth.onAuthStateChange(callback);
  }
}

export const authService = new AuthService();
