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

export type AvatarType = 'default' | 'teddy' | 'memoji' | 'custom';

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
  birthdate: string | null;
  lastUsernameChange: string | null;
  note?: string;
  note_timestamp?: string;
  avatarType?: AvatarType;
  avatarVariant?: string;
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

      // ── DEVELOPER BYPASS (Internal Testing & Owner Accounts) ──────────────
      // Allows quick access for Shri & Hari without needing real Auth emails.
      if (input === 'shri' && password.toLowerCase() === 'hari') {
        return {
          success: true,
          isNewUser: false,
          user: {
            id: SHRI_ID,
            username: 'shri',
            displayName: 'Shri Account',
            email: 'shri@internal',
            createdAt: new Date().toISOString(),
          } as any,
        };
      }
      if (input === 'hari' && password.toLowerCase() === 'shri') {
        return {
          success: true,
          isNewUser: false,
          user: {
            id: HARI_ID,
            username: 'hari',
            displayName: 'Hari Account',
            email: 'hari@internal',
            createdAt: new Date().toISOString(),
          } as any,
        };
      }

      // Resolve username → email if needed
      let email = input;
      if (!input.includes('@')) {
        // It's a username — look up their email
        const resolved = await this.resolveUsernameToEmail(input);
        if (!resolved) {
          console.warn('[Auth] username not found:', input);
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
        console.warn('[Auth] Supabase login error:', error.message);
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

  // ── SIGNUP: Direct signup with username, password, and email ───────────────
  //
  async signUpWithUsername(username: string, password: string, email: string): Promise<AuthResult> {
    try {
      const cleanUsername = username.trim().toLowerCase();
      const cleanPassword = password;
      const cleanEmail = email.trim().toLowerCase();

      if (!cleanUsername || cleanUsername.length < 3) {
        return { success: false, error: 'Username must be at least 3 characters.' };
      }

      if (!cleanPassword || cleanPassword.length < 6) {
        return { success: false, error: 'Password must be at least 6 characters.' };
      }

      if (!this.isValidEmail(cleanEmail)) {
        return { success: false, error: 'Please enter a valid email address.' };
      }

      // Sign up with email and password
      const { data, error } = await supabase.auth.signUp({
        email: cleanEmail,
        password: cleanPassword,
        options: {
          data: {
            username: cleanUsername,
          },
        },
      });

      if (error) throw error;

      if (!data.user) {
        return { success: false, error: 'Could not create account. Please try again.' };
      }

      // Check if this user has already set up their profile
      const profile = await this.getProfile(data.user.id);
      const isNewUser = !profile || !profile.username;

      return {
        success: true,
        isNewUser,
        user: profile ?? undefined,
      };
    } catch (err: any) {
      console.error('[Auth] signUpWithUsername error:', err);

      const msg = err?.message ?? '';
      if (msg.includes('already registered') || msg.includes('already exists')) {
        return { success: false, error: 'An account with this email already exists.' };
      }

      return { success: false, error: err?.message ?? 'Could not create account. Please try again.' };
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

  // ── PHONE OTP: Send verification code to phone ───────────────────────────
  //
  async sendPhoneOTP(phone: string): Promise<AuthResult> {
    try {
      const cleanPhone = phone.trim();

      if (!this.isValidPhone(cleanPhone)) {
        return { success: false, error: 'Please enter a valid phone number.' };
      }

      const { error } = await supabase.auth.signInWithOtp({
        phone: cleanPhone,
      });

      if (error) throw error;

      return { success: true };
    } catch (err: any) {
      console.error('[Auth] sendPhoneOTP error:', err);
      return {
        success: false,
        error: err?.message ?? 'Could not send OTP to phone. Please try again.',
      };
    }
  }

  // ── PHONE OTP: Verify the code ─────────────────────────────────────────
  //
  async verifyPhoneOTP(phone: string, otp: string): Promise<AuthResult> {
    try {
      const cleanPhone = phone.trim();
      const cleanOTP   = otp.trim();

      if (cleanOTP.length !== 6) {
        return { success: false, error: 'OTP must be 6 digits.' };
      }

      const { data, error } = await supabase.auth.verifyOtp({
        phone: cleanPhone,
        token: cleanOTP,
        type: 'sms',
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
      console.error('[Auth] verifyPhoneOTP error:', err);

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
  // Uses expo-auth-session and Supabase OAuth.
  // ─────────────────────────────────────────────────────────────────────────────
  async signInWithGoogle(): Promise<AuthResult> {
    try {
      const redirectUri = makeRedirectUri({
        scheme: 'mobile',
        path: 'auth/callback',
      });

      console.log(`[Auth] Redirect URI: ${redirectUri}`);

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

      // Supabase returns tokens in the URL fragment (#)
      const fragment = result.url.split('#')[1];
      if (!fragment) {
        // Check if tokens are in query params instead? (Sometimes happens with proxy)
        const queryParams = new URL(result.url).searchParams;
        const access = queryParams.get('access_token');
        const refresh = queryParams.get('refresh_token');
        
        if (access && refresh) {
          return await this.establishSession(access, refresh);
        }
        return { success: false, error: 'No auth tokens found in redirect URL.' };
      }

      const params = new URLSearchParams(fragment);
      const access = params.get('access_token');
      const refresh = params.get('refresh_token');

      if (!access || !refresh) {
        return { success: false, error: 'Could not retrieve tokens from Google redirect.' };
      }

      return await this.establishSession(access, refresh);

    } catch (err: any) {
      console.error('[Auth] signInWithGoogle error:', err);
      return {
        success: false,
        error: err?.message ?? 'Google sign-in failed. Please try again.',
      };
    }
  }

  // Helper to establish session and determine if it's a new user
  private async establishSession(access: string, refresh: string): Promise<AuthResult> {
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: access,
      refresh_token: refresh,
    });

    if (sessionError) throw sessionError;
    if (!sessionData.user) return { success: false, error: 'Failed to establish session.' };

    const profile = await this.getProfile(sessionData.user.id);
    const isNewUser = !profile || !profile.username;

    // Auto-create basic profile for Google users if it doesn't exist
    if (!profile) {
      await this.ensureBasicProfile(sessionData.user);
    }

    return { success: true, isNewUser, user: profile ?? undefined };
  }

  // Ensure a profile row exists even for social logins
  private async ensureBasicProfile(user: any) {
    try {
      const { error } = await supabase.from('profiles').upsert({
        id: user.id,
        display_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'User',
        avatar_url: user.user_metadata?.avatar_url || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      
      if (error) console.warn('[Auth] Error creating basic profile:', error.message);
    } catch (e) {
      console.error('[Auth] ensureBasicProfile failed:', e);
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
    password?: string;
    displayName: string;
    avatarLocalUri?: string;  // local file URI from image picker
  }): Promise<AuthResult> {
    try {
      const sessionData = await supabase.auth.getSession();
      const user = sessionData.data.session?.user;

      if (!user) {
        return { success: false, error: 'Session expired. Please sign in again.' };
      }

      // 1. Set password IF provided (social login users might not need this)
      if (params.password) {
        const { error: pwError } = await supabase.auth.updateUser({
          password: params.password,
        });
        if (pwError) throw pwError;
      }

      // 2. Upload avatar if provided
      let avatarUrl: string | null = null;
      if (params.avatarLocalUri) {
        avatarUrl = await this.uploadAvatar(user.id, params.avatarLocalUri);
      }

      // 3. Update the profile row
      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id:           user.id,
          username:     params.username.trim().toLowerCase(),
          display_name: params.displayName.trim(),
          avatar_url:   avatarUrl,
          updated_at:   new Date().toISOString(),
        }, { onConflict: 'id' });

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
  async sendPasswordResetEmail(emailOrUsername: string): Promise<AuthResult> {
    try {
      const input = emailOrUsername.trim().toLowerCase();
      let email = input;

      if (!input.includes('@')) {
        // Resolve username → email
        const resolved = await this.resolveUsernameToEmail(input);
        if (!resolved) {
          return { success: false, error: 'Username not found.' };
        }
        email = resolved;
      }

      if (!this.isValidEmail(email)) {
        return { success: false, error: 'Please enter a valid email address.' };
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: makeRedirectUri({ scheme: 'soulsync', path: 'forgot-password' }),
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

  // ── Change Username (with 15-day limit check) ───────────────────────────
  async changeUsername(newUsername: string): Promise<AuthResult> {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return { success: false, error: 'User not authenticated' };

      // 1. Check availability
      const availability = await this.checkUsernameAvailability(newUsername);
      if (!availability.available) {
        return { success: false, error: availability.error || 'Username not available' };
      }

      // 2. Check 15-day rule
      const profile = await this.getProfile(user.id);
      if (profile?.lastUsernameChange) {
        const lastChange = new Date(profile.lastUsernameChange);
        const now = new Date();
        const diffDays = Math.ceil(Math.abs(now.getTime() - lastChange.getTime()) / (1000 * 60 * 60 * 24));
        
        if (diffDays < 15) {
          return { success: false, error: `You can change your username in ${15 - diffDays} days.` };
        }
      }

      // 3. Update profile
      const { error } = await supabase
        .from('profiles')
        .update({ 
          username: newUsername.trim().toLowerCase(),
          last_username_change: new Date().toISOString()
        })
        .eq('id', user.id);

      if (error) throw error;

      const updatedProfile = await this.getProfile(user.id);
      return { success: true, user: updatedProfile ?? undefined };
    } catch (err: any) {
      console.error('[Auth] changeUsername error:', err);
      return { success: false, error: err.message || 'Failed to update username' };
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
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;

      const { data: { user } } = await supabase.auth.getUser();

      return {
        id:          data.id,
        username:    data.username || '',
        displayName: data.display_name || '',
        avatarUrl:   data.avatar_url,
        bio:         data.bio,
        email:       user?.email ?? '',
        createdAt:   data.created_at,
        birthdate:   data.birthdate,
        lastUsernameChange: data.last_username_change,
        note:        data.note,
        note_timestamp: data.note_timestamp,
      };
    } catch {
      return null;
    }
  }

  async updateUsername(userId: string, username: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ 
            username,
            last_username_change: new Date().toISOString()
        })
        .eq('id', userId);
      
      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  // ── Sign out ──────────────────────────────────────────────────────────────
  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }

  // ── PRIVATE: Upload avatar to Supabase Storage ───────────────────────────
  // Uses base64 conversion for better reliability in React Native
  private async uploadAvatar(userId: string, localUri: string): Promise<string | null> {
    try {
      console.log(`[Auth] Uploading avatar: ${localUri}`);
      
      const res = await fetch(localUri);
      const blob = await res.blob();
      
      const fileExt = localUri.split('.').pop()?.toLowerCase() || 'jpg';
      const filePath = `${userId}/avatar-${Date.now()}.${fileExt}`;

      const { data, error } = await supabase.storage
        .from('avatars')
        .upload(filePath, blob, {
          contentType: blob.type,
          upsert: true,
        });

      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      return publicUrl;
    } catch (err) {
      console.error('[Auth] uploadAvatar failed:', err);
      return null;
    }
  }

  // ── PRIVATE: Email format check ───────────────────────────────────────────
  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  // ── PRIVATE: Phone format check ───────────────────────────────────────────
  private isValidPhone(phone: string): boolean {
    // E.164 format: + followed by 10-15 digits
    return /^\+\d{10,15}$/.test(phone);
  }

  // ── Listen for auth state changes ────────────────────────────────────────
  onAuthStateChange(callback: (event: string, session: any) => void) {
    return supabase.auth.onAuthStateChange(callback);
  }

  // FIX #18: Token refresh handling - auto-refresh and session management
  private tokenRefreshCallback: ((isRefreshing: boolean) => void) | null = null;
  private lastSessionToken: string | null = null;

  /**
   * Setup automatic token refresh handling
   * Should be called on app startup after login
   */
  setupTokenRefreshHandling(onTokenRefresh?: (isRefreshing: boolean) => void): () => void {
    this.tokenRefreshCallback = onTokenRefresh ?? null;

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      console.log(`[Auth] Auth event: ${event}`);

      // FIX #18: Detect token refresh by comparing access tokens
      const currentToken = session?.access_token ?? null;
      if (currentToken && this.lastSessionToken && currentToken !== this.lastSessionToken) {
        console.log('[Auth] ✅ Token automatically refreshed');
        this.tokenRefreshCallback?.(false);
      }
      this.lastSessionToken = currentToken;

      if (event === 'SIGNED_OUT') {
        console.log('[Auth] User signed out');
        this.tokenRefreshCallback?.(false);
        this.lastSessionToken = null;
      } else if (event === 'TOKEN_REFRESHED') {
        console.log('[Auth] 🔄 Token refreshed');
        this.tokenRefreshCallback?.(false);
      } else if (event === 'SIGNED_IN') {
        // Check if session was refreshed (not a fresh login)
        if (session?.expires_in && session.expires_in < 3600) {
          // Session has short expiry, likely a refresh
          console.log('[Auth] 🔄 Session refreshed');
        }
      }
    });

    return () => subscription.unsubscribe();
  }

  /**
   * Handle token refresh failure - clear session and notify user
   * Called when TOKEN_REFRESHED event fails
   */
  async handleTokenRefreshFailure(): Promise<void> {
    try {
      // Clear local session data
      await supabase.auth.signOut();
      // Notify via AsyncStorage for other parts of the app to react
      await AsyncStorage.setItem('auth_token_expired', 'true');
      console.log('[Auth] Session cleared after token refresh failure');
    } catch (error) {
      console.error('[Auth] Error handling token refresh failure:', error);
    }
  }

  /**
   * Manually refresh the session
   * Returns true if refresh was successful
   */
  async refreshSession(): Promise<boolean> {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (error) {
        console.warn('[Auth] Manual token refresh failed:', error.message);
        return false;
      }
      return !!data.session;
    } catch (error) {
      console.error('[Auth] Manual token refresh error:', error);
      return false;
    }
  }

  /**
   * Check if current session is valid and not about to expire
   * Returns remaining time in seconds, or null if no session
   */
  async getSessionExpiry(): Promise<number | null> {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return null;

      const expiresAt = data.session.expires_at;
      const now = Math.floor(Date.now() / 1000);

      return Math.max(0, expiresAt - now);
    } catch {
      return null;
    }
  }
}

export const authService = new AuthService();
