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

import { supabase, SHRI_ID, HARI_ID } from '../config/supabase';
import { storageService } from './StorageService';

import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { makeRedirectUri } from 'expo-auth-session';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID } from '../config/googleAuth';

// Required for Google OAuth on Android/iOS (legacy browser flow fallback)
WebBrowser.maybeCompleteAuthSession();

// Lazy-load the native Google Sign-In module so the app doesn't crash in
// dev builds that haven't been rebuilt with the native binary yet. When the
// module is missing, signInWithGoogle falls back to the browser-based OAuth.
let GoogleSignin: any = null;
let googleStatusCodes: any = null;
try {
  const gs = require('@react-native-google-signin/google-signin');
  GoogleSignin = gs.GoogleSignin;
  googleStatusCodes = gs.statusCodes;
  if (
    GoogleSignin &&
    GOOGLE_WEB_CLIENT_ID &&
    !GOOGLE_WEB_CLIENT_ID.includes('REPLACE_WITH_WEB')
  ) {
    console.log('[Auth] Initializing Native Google Sign-In with ID:', GOOGLE_WEB_CLIENT_ID.substring(0, 10) + '...');
    GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      iosClientId: GOOGLE_IOS_CLIENT_ID,
      offlineAccess: false,
    });
  }
} catch (err) {
  console.log('[Auth] Native Google Sign-In unavailable, will use browser flow.');
}

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
  teddyVariant?: 'boy' | 'girl';
  country?: string | null;
  countryCode?: string | null;
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

      // ── SUPER USER ACCESS (Owner Accounts) ────────────────────────────────
      // Shri & Hari are super users with full access in all environments.
      const isShri = input === 'shri' && password.toLowerCase() === 'hari';
      const isHari = input === 'hari' && password.toLowerCase() === 'shri';

      if (isShri || isHari) {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => supabase.auth.signOut().catch(() => {}));
        return {
          success: true,
          isNewUser: false,
          user: {
            id: isShri ? SHRI_ID : HARI_ID,
            username: isShri ? 'shri' : 'hari',
            displayName: isShri ? 'Shri' : 'Hari',
            email: isShri ? 'shri@internal' : 'hari@internal',
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

      if (!cleanPassword || cleanPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters.' };
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

      // ── ROBUST PROFILE CHECK (Safety fallback for slow triggers) ────
      let profile = await this.getProfile(data.user.id);
      
      if (!profile) {
          console.log('[Auth] Profile not found after OTP verify, waiting for trigger...');
          await new Promise(resolve => setTimeout(resolve, 1500));
          profile = await this.getProfile(data.user.id);
      }

      // ── TRIGGER FALLBACK ──────────────────────────────────────────
      if (!profile) {
          console.log('[Auth] Database trigger fallback: Manual profile creation for email user');
          await this.ensureBasicProfile(data.user);
          profile = await this.getProfile(data.user.id);
      }

      const isNewUser = !profile || !profile.username || profile.username.startsWith('user_');

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
  // Supports both standard Implicit Flow and modern PKCE (code exchange)
  // ─────────────────────────────────────────────────────────────────────────────
  async signInWithGoogle(): Promise<AuthResult> {
    const hasNativeModule = !!GoogleSignin;
    const hasRealClientId =
      !!GOOGLE_WEB_CLIENT_ID && !GOOGLE_WEB_CLIENT_ID.includes('REPLACE_WITH');
    const nativeReady = hasNativeModule && hasRealClientId;

    console.log(
      `[Auth] Google Sign-In flow → nativeModule: ${hasNativeModule}, realClientId: ${hasRealClientId}, using: ${nativeReady ? 'NATIVE' : 'BROWSER'}`
    );

    if (nativeReady) {
      return this.signInWithGoogleNative();
    }
    return this.signInWithGoogleBrowser();
  }

  private async signInWithGoogleNative(): Promise<AuthResult> {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

      await GoogleSignin.signOut().catch(() => {});
      const userInfo: any = await GoogleSignin.signIn();
      const idToken: string | undefined =
        userInfo?.idToken ?? userInfo?.data?.idToken;

      if (!idToken) {
        console.error('[Auth] Native Google Sign-In returned no idToken', userInfo);
        return { success: false, error: 'Google sign-in did not return an ID token.' };
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });

      if (error) {
        console.error('[Auth] Supabase signInWithIdToken error:', error);
        return { success: false, error: error.message };
      }

      if (!data.user) {
        return { success: false, error: 'Google sign-in failed.' };
      }

      const profile = await this.getProfile(data.user.id);
      const isNewUser = !profile || !profile.username;

      return {
        success: true,
        isNewUser,
        user: profile ?? undefined,
      };
    } catch (err: any) {
      const codes = googleStatusCodes;
      if (codes && err?.code === codes.SIGN_IN_CANCELLED) {
        return { success: false, error: 'Sign-in cancelled.' };
      }
      if (codes && err?.code === codes.IN_PROGRESS) {
        return { success: false, error: 'Sign-in already in progress.' };
      }
      if (codes && err?.code === codes.PLAY_SERVICES_NOT_AVAILABLE) {
        return { success: false, error: 'Google Play Services not available.' };
      }
      console.error('[Auth] signInWithGoogle error:', err);
      return {
        success: false,
        error: err?.message ?? 'Google sign-in failed. Please try again.',
      };
    }
  }

  private async signInWithGoogleBrowser(): Promise<AuthResult> {
    try {
      let redirectUri: string;
      try {
        const scheme = Constants.expoConfig?.scheme || 'mobile';
        redirectUri = makeRedirectUri({ scheme, path: 'auth/callback' });
      } catch {
        redirectUri = 'mobile://auth/callback';
      }

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectUri, skipBrowserRedirect: true },
      });
      if (error) return { success: false, error: error.message };

      const result = await WebBrowser.openAuthSessionAsync(data.url ?? '', redirectUri);
      if (result.type !== 'success') {
        return { success: false, error: `Google sign-in was cancelled: ${result.type}` };
      }

      const urlString = result.url;
      const extract = (name: string) => {
        const m = urlString.match(new RegExp(`[#?&]${name}=([^&]*)`));
        return m ? decodeURIComponent(m[1]) : null;
      };

      const code = extract('code');
      const access = extract('access_token');
      const refresh = extract('refresh_token');
      const oauthError = extract('error');
      const oauthErrorDesc = extract('error_description');

      if (oauthError) {
        return { success: false, error: `Google Auth Error: ${oauthErrorDesc || oauthError}` };
      }
      if (code) return this.exchangeCodeForSession(code);
      if (access && refresh) return this.establishSession(access, refresh);
      return { success: false, error: 'Google sign-in failed: missing credentials.' };
    } catch (err: any) {
      console.error('[Auth] signInWithGoogleBrowser error:', err);
      return { success: false, error: err?.message ?? 'Google sign-in failed.' };
    }
  }

  // Helper to exchange PKCE code for a proper auth session
  private async exchangeCodeForSession(code: string): Promise<AuthResult> {
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    
    if (sessionError) {
      console.error('[Auth] Code exchange error:', sessionError);
      return { success: false, error: `Code Exchange Error: ${sessionError.message}` } as any; // Temporary cast due to strict types, throwing might crash it silently later
    }
    
    if (!sessionData.user) {
      return { success: false, error: 'Failed to exchange code for a user session.' };
    }
    
    console.log(`[Auth] Session established via code exchange for user: ${sessionData.user.id}`);
    return await this.finalizeSocialLogin(sessionData.user);
  }

  // Helper to establish session via direct access/refresh tokens
  private async establishSession(access: string, refresh: string): Promise<AuthResult> {
    console.log('[Auth] Establishing session with tokens...');
    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: access,
      refresh_token: refresh,
    });

    if (sessionError) {
      console.error('[Auth] Session establishment error:', sessionError);
      throw sessionError;
    }
    if (!sessionData.user) {
      console.warn('[Auth] No user returned after setSession');
      return { success: false, error: 'Failed to establish session.' };
    }

    console.log(`[Auth] Session established for user: ${sessionData.user.id}`);
    return await this.finalizeSocialLogin(sessionData.user);
  }

  // Unified post-login processing for all social connections
  private async finalizeSocialLogin(user: any): Promise<AuthResult> {
    let profile = await this.getProfile(user.id);
    
    // Safety Retry: Database trigger might be slow on first signup
    if (!profile) {
      console.log('[Auth] Profile not found immediately after social signup, waiting for trigger...');
      await new Promise(resolve => setTimeout(resolve, 1500));
      profile = await this.getProfile(user.id);
    }
    
    // NEW USER LOGIC: 
    // They are new if they have no profile, no username, OR if they have the system-generated temp username
    const isNewUser = !profile || !profile.username || profile.username.startsWith('temp_') || profile.username.startsWith('user_');

    // Auto-create basic profile row if one doesn't exist at all yet (safety fallback for the database trigger)
    if (!profile) {
      console.log('[Auth] Database trigger fallback: Manual profile creation');
      await this.ensureBasicProfile(user);
      profile = await this.getProfile(user.id);
    }

    return { success: true, isNewUser, user: profile ?? undefined };
  }

  // Ensure a profile row exists even for social logins
  private async ensureBasicProfile(user: any) {
    try {
      const email = user.email || '';
      const isInternalEmail = email.includes('.internal@soul.dev');
      
      let defaultName = user.user_metadata?.full_name || email.split('@')[0] || 'User';
      let defaultUsername = `user_${user.id.substring(0, 8)}`;
      
      // If it's an internal bypass account, set a nice name and username
      if (isInternalEmail) {
        if (email.startsWith('shri')) {
          defaultName = 'Shri';
          defaultUsername = 'shri';
        } else if (email.startsWith('hari')) {
          defaultName = 'Hari';
          defaultUsername = 'hari';
        }
      }

      const { error } = await supabase.from('profiles').upsert({
        id: user.id,
        username: defaultUsername,
        display_name: defaultName,
        avatar_url: user.user_metadata?.avatar_url || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      
      if (error) {
        console.warn('[Auth] Error creating basic profile:', error.message);
        throw error;
      }
    } catch (e) {
      console.error('[Auth] ensureBasicProfile failed after retries:', e);
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
    country?: string;
    countryCode?: string;
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
          country:      params.country,
          country_code: params.countryCode,
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
        redirectTo: makeRedirectUri({ scheme: 'soul', path: 'forgot-password' }),
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
      const { data: sessionData } = await supabase.auth.getSession();
      const sessionUser = sessionData.session?.user;
      const sessionUserMeta = sessionUser?.user_metadata || {};

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      // For Super Users (Shri/Hari), if no DB record exists, return hardcoded bypass profile
      if ((!data || error) && (userId === SHRI_ID || userId === HARI_ID)) {
        const isShri = userId === SHRI_ID;
        return {
          id: userId,
          username: isShri ? 'shri' : 'hari',
          displayName: isShri ? 'Shri' : 'Hari',
          avatarUrl: null,
          bio: isShri ? 'SoulSync Founder | Jai Shree Ram' : 'SoulSync Dev | Om Namah Shivay',
          email: isShri ? 'shri@internal' : 'hari@internal',
          createdAt: new Date(0).toISOString(),
          birthdate: null,
          lastUsernameChange: null,
          avatarType: 'teddy',
          teddyVariant: isShri ? 'boy' : 'boy', // Defaulting Shri back to boy as well
        };
      }

      if (error || !data) return null;

      const fallbackDisplayName =
        data.display_name ||
        sessionUserMeta?.full_name ||
        sessionUserMeta?.name ||
        sessionUser?.email?.split('@')[0] ||
        data.username ||
        '';

      return {
        id:          data.id,
        username:    data.username || '',
        displayName: fallbackDisplayName,
        avatarUrl:   data.avatar_url,
        bio:         data.bio,
        email:       sessionUser?.email ?? '',
        createdAt:   data.created_at,
        birthdate:   data.birthdate,
        lastUsernameChange: data.last_username_change,
        note:        data.note,
        note_timestamp: data.note_timestamp,
        avatarType:  data.avatar_type,
        teddyVariant: data.teddy_variant,
        country:     data.country,
        countryCode: data.country_code,
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

  // ── Upload avatar to Cloudflare R2 Storage ────────────────────────────────────
  // Uses highest-level StorageService for robust Android/iOS URI resolution.
  async uploadAvatar(userId: string, localUri: string): Promise<string | null> {
    console.log(`[Auth] Uploading avatar for user ${userId}: ${localUri}`);
    
    // Bucket is 'avatars', folder is the user ID for organization.
    // We let errors bubble up so profile-edit.tsx can show the real cause in the alert.
    const storageKey = await storageService.uploadImage(
      localUri, 
      'avatars', 
      userId
    );

    if (!storageKey) {
      throw new Error('Upload failed: Storage service returned no key');
    }

    return storageKey;
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
  /**
   * Required for Google OAuth on Android/iOS (legacy browser flow fallback).
   * Should be called when the auth screens mount.
   */
  maybeCompleteAuthSession() {
    try {
      WebBrowser.maybeCompleteAuthSession();
    } catch (e) {
      console.warn('[Auth] Error in maybeCompleteAuthSession:', e);
    }
  }
}

export const authService = new AuthService();
