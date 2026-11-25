import * as Linking from 'expo-linking';
import * as SecureStore from 'expo-secure-store';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { setAdsConsent } from '@/lib/ads';
import { track } from '@/lib/analytics';
import { DateOfBirthField } from '@/components/date-of-birth-field';
import { ThemedText } from '@/components/themed-text';
import { AuthScreen } from '@/components/ui/auth-screen';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { TERMS_VERSION } from '@/constants/legal';
import { useAuth } from '@/lib/auth-context';
import { useSignup } from '@/lib/signup-context';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/hooks/use-theme';
import { dobStatus, toIsoDate, validateDisplayName, validateHandleFormat } from '@/lib/validation';
import type { SignupIdentityMetadata } from '@/types';

type Availability = 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'error';
/** Result of a completed availability check, tied to the handle it was run for. */
type CheckResult = { handle: string; result: 'available' | 'taken' | 'error' };

const HANDLE_DEBOUNCE_MS = 450;
const TODAY = new Date();
/** Under-13 refusal cooldown (brief 6A): a refused date of birth can't simply be
 *  retried with a new date on this device. SecureStore survives reinstalls on iOS.
 *  7 days mirrors the server's signup_age_retry_days setting (unreadable pre-auth). */
const AGE_BLOCK_KEY = 'phixr-age-block-until';
const AGE_BLOCK_DAYS = 7;

export default function SignupIdentityScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { draft, update, reset } = useSignup();
  const { session, reload } = useAuth();

  // Resume mode: the user is already authenticated (verified) but has no profile row.
  const isResume = !!session;
  const metadata = session?.user?.user_metadata as Partial<SignupIdentityMetadata> | undefined;

  const [displayName, setDisplayName] = useState(draft.displayName || metadata?.display_name || '');
  const [ageBlockedUntil, setAgeBlockedUntil] = useState<Date | null>(null);
  useEffect(() => {
    void SecureStore.getItemAsync(AGE_BLOCK_KEY)
      .then((v) => {
        if (v && new Date(v) > new Date()) setAgeBlockedUntil(new Date(v));
      })
      .catch(() => {});
  }, []);
  const [handle, setHandle] = useState(draft.handle || metadata?.handle || '');
  const [dob, setDob] = useState<Date | null>(
    draft.dateOfBirth
      ? new Date(`${draft.dateOfBirth}T00:00:00`)
      : metadata?.date_of_birth
        ? new Date(`${metadata.date_of_birth}T00:00:00`)
        : null,
  );

  const [touched, setTouched] = useState<{ name?: boolean; handle?: boolean; dob?: boolean }>({});
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Debounced live handle availability against profiles.handle (anon-callable RPC).
  // Only the async result is stored; the synchronous states below are derived.
  useEffect(() => {
    if (!handle || validateHandleFormat(handle)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('is_handle_available', { _handle: handle });
      if (cancelled) return;
      setCheckResult({ handle, result: error ? 'error' : data ? 'available' : 'taken' });
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [handle]);

  const availability: Availability = !handle
    ? 'idle'
    : validateHandleFormat(handle)
      ? 'invalid'
      : checkResult?.handle === handle
        ? checkResult.result
        : 'checking';

  const nameError = touched.name ? validateDisplayName(displayName) : null;
  const dobState = dob ? dobStatus(dob) : null;
  const dobError = touched.dob
    ? !dob
      ? 'Enter your date of birth.'
      : dobState === 'under13'
        ? 'You must be at least 13 to use Phixr.'
        : null
    : null;

  const handleError =
    touched.handle && availability === 'invalid'
      ? validateHandleFormat(handle)
      : availability === 'taken'
        ? 'That handle is taken.'
        : availability === 'error'
          ? "Couldn't check that handle. Try again."
          : null;

  const [acceptedTerms, setAcceptedTerms] = useState(false);
  // Ads personalisation (brief 8D, moved to signup): its own switch beside the
  // T&C tick — never bundled into it — shown to adults only, on by default,
  // changeable any time in Settings. Minors are always non-personalised (the
  // server refuses anything else).
  const [adsPersonalised, setAdsPersonalised] = useState(true);
  const adsChoice = dobState === 'adult' && adsPersonalised;

  const canSubmit =
    !validateDisplayName(displayName) &&
    availability === 'available' &&
    !!dob &&
    dobState !== 'under13' &&
    acceptedTerms;

  async function onSubmit() {
    setTouched({ name: true, handle: true, dob: true });
    setFormError(null);
    // Under-13 (brief 6A): refuse kindly, and remember the refusal on this
    // device so a different date can't be tried straight away.
    if (dob && dobStatus(dob) === 'under13') {
      const until = new Date(Date.now() + AGE_BLOCK_DAYS * 24 * 60 * 60 * 1000);
      setAgeBlockedUntil(until);
      void SecureStore.setItemAsync(AGE_BLOCK_KEY, until.toISOString()).catch(() => {});
      return;
    }
    if (ageBlockedUntil && ageBlockedUntil > new Date()) return;
    if (!canSubmit || !dob) return;

    const isoDob = toIsoDate(dob);
    const isPrivate = dobStatus(dob) === 'minor';

    setSubmitting(true);
    try {
      if (isResume && session) {
        // Verified but profile missing → create it directly (handle may have changed).
        const { error } = await supabase.from('profiles').insert({
          id: session.user.id,
          handle,
          display_name: displayName.trim(),
          date_of_birth: isoDob,
          is_private: isPrivate,
          terms_version: TERMS_VERSION,
          terms_accepted_at: new Date().toISOString(),
        });
        if (error) {
          if (error.code === '23505') setCheckResult({ handle, result: 'taken' });
          else setFormError(error.message);
          return;
        }
        // Record the signup ads choice (best-effort; stays 'unset' → treated
        // as non-personalised if this fails, and Settings can set it later).
        await setAdsConsent(adsChoice ? 'personalised' : 'non_personalised').catch(() => {});
        // Launch funnel (brief 10): account fully created on the resume path.
        const { trackFirst } = await import('@/lib/analytics');
        void trackFirst(session.user.id, 'signup_completed');
        reset();
        reload(); // auth context re-resolves the profile → routes to tabs
        return;
      }

      // Fresh signup: NOW create the auth user (after the under-13 gate), carrying the
      // identity in user_metadata so the profile can be created on verification.
      update({ displayName: displayName.trim(), handle, dateOfBirth: isoDob });
      const { data, error } = await supabase.auth.signUp({
        email: draft.email,
        password: draft.password,
        options: {
          emailRedirectTo: Linking.createURL('/'),
          data: {
            display_name: displayName.trim(),
            handle,
            date_of_birth: isoDob,
            terms_version: TERMS_VERSION,
            terms_accepted_at: new Date().toISOString(),
            ads_personalised: adsChoice,
          } satisfies SignupIdentityMetadata,
        },
      });
      if (error) {
        if (error.message.toLowerCase().includes('already registered')) {
          setFormError('An account already exists for this email. Try logging in instead.');
        } else {
          setFormError(error.message);
        }
        return;
      }
      track('signup_started');
      if (data.session) {
        // Email confirmation is off → we're already signed in. Clear the in-memory
        // signup draft and let the root guard carry us on (profile → onboarding →
        // deck). A verify-email banner nudges them to confirm later.
        reset();
        router.replace('/');
      } else {
        // Confirmation required → wait on the "check your email" screen.
        router.replace('/(auth)/signup/verify');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Under-13 refusal (brief 6A): a kind full stop, not an error state.
  if (ageBlockedUntil && ageBlockedUntil > new Date()) {
    return (
      <AuthScreen title="See you soon" subtitle=" ">
        <ThemedText type="default">
          Phixr is for people aged 13 and up, so we can&apos;t set up your account just yet.
        </ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          We&apos;re really glad you want to be here — and we&apos;d love to see you when
          you&apos;re old enough. This device can try again after{' '}
          {ageBlockedUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.
        </ThemedText>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title={isResume ? 'Finish setting up' : 'Tell us about you'}
      subtitle={isResume ? 'Pick a handle to finish your profile.' : 'Step 2 of 3 — your identity.'}
      onBack={isResume ? undefined : () => router.back()}
      footer={
        <Button
          title={isResume ? 'Finish setup' : 'Create account'}
          onPress={onSubmit}
          loading={submitting}
        />
      }>
      {formError ? <FormMessage tone="error">{formError}</FormMessage> : null}

      <TextField
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        onBlur={() => setTouched((t) => ({ ...t, name: true }))}
        error={nameError}
        autoCapitalize="words"
        placeholder="Your name"
        maxLength={50}
      />

      <TextField
        label="Handle"
        value={handle}
        onChangeText={(v) => setHandle(v.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
        onBlur={() => setTouched((t) => ({ ...t, handle: true }))}
        error={handleError}
        hint={
          availability === 'available'
            ? 'Available'
            : '3–30 characters: lowercase letters, numbers, underscore.'
        }
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="yourhandle"
        maxLength={30}
        accessoryRight={<HandleStatus availability={availability} />}
      />

      <DateOfBirthField
        label="Date of birth"
        value={dob}
        onChange={setDob}
        onBlur={() => setTouched((t) => ({ ...t, dob: true }))}
        error={dobError}
        hint="You can't change this later."
        maximumDate={TODAY}
      />

      {dobState === 'under13' ? (
        <FormMessage tone="error">
          You need to be at least 13 years old to create a Phixr account.
        </FormMessage>
      ) : dobState === 'minor' ? (
        <FormMessage tone="info">
          Because you are under 18, your account will be private by default. You can review this in
          settings later.
        </FormMessage>
      ) : null}

      <Pressable
        style={styles.termsRow}
        onPress={() => setAcceptedTerms((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acceptedTerms }}>
        <Ionicons
          name={acceptedTerms ? 'checkbox' : 'square-outline'}
          size={24}
          color={acceptedTerms ? BRAND.accent : theme.textSecondary}
        />
        <ThemedText type="small" style={styles.termsText}>
          I agree to the{' '}
          <ThemedText type="small" style={{ color: BRAND.accent }} onPress={() => router.push('/legal/terms')}>
            Terms of Service
          </ThemedText>{' '}
          and{' '}
          <ThemedText type="small" style={{ color: BRAND.accent }} onPress={() => router.push('/legal/privacy')}>
            Privacy Policy
          </ThemedText>
          .
        </ThemedText>
      </Pressable>

      {/* Ads personalisation (8D): a separate switch, never part of the T&C
          tick. Adults only — minors are always non-personalised. */}
      {dobState === 'adult' ? (
        <Pressable
          style={styles.termsRow}
          onPress={() => setAdsPersonalised((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: adsPersonalised }}>
          <Ionicons
            name={adsPersonalised ? 'checkbox' : 'square-outline'}
            size={24}
            color={adsPersonalised ? BRAND.accent : theme.textSecondary}
          />
          <ThemedText type="small" style={styles.termsText}>
            Personalise the ads I see using my age group, area and interests. You
            see the same number of ads either way — change this any time in
            Settings.
          </ThemedText>
        </Pressable>
      ) : null}
    </AuthScreen>
  );
}

const styles = StyleSheet.create({
  termsRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4 },
  termsText: { flex: 1, lineHeight: 20 },
});

function HandleStatus({ availability }: { availability: Availability }) {
  const theme = useTheme();
  if (availability === 'checking')
    return <ActivityIndicator size="small" color={theme.textSecondary} />;
  if (availability === 'available')
    return <Ionicons name="checkmark-circle" size={22} color={theme.success} />;
  if (availability === 'taken' || availability === 'invalid')
    return <Ionicons name="close-circle" size={22} color={theme.danger} />;
  return null;
}
