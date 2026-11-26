import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';

import { AuthScreen } from '@/components/ui/auth-screen';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { PasswordStrengthMeter } from '@/components/ui/password-strength-meter';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import { latestIncomingUrl } from '@/lib/incoming-link';
import { supabase } from '@/lib/supabase';
import { validatePassword, validatePasswordConfirm } from '@/lib/validation';

/**
 * Where the "Reset your password" email link lands (forgot-password sends
 * redirectTo = Linking.createURL('/reset-password')).
 *
 * Supabase appends the one-time recovery session to the link: in the URL fragment
 * (#access_token=…&refresh_token=…&type=recovery) for the implicit flow, or as
 * ?code=… for PKCE. We turn that into a signed-in session, then let the person choose
 * a new password with updateUser(). Expired or already-used links show a clear message
 * and a way to send a fresh one.
 *
 * This route sits outside the (auth) group and the root auth guard leaves it alone, so
 * the guard can't bounce people to the login screen (before) or the feed (after the
 * recovery session starts) while they're mid-reset.
 */

type Phase = 'checking' | 'ready' | 'invalid' | 'saving';

function hasResetParams(p: Record<string, string>): boolean {
  return !!(p.access_token || p.code || p.token_hash || p.error || p.error_description);
}

function linkParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = [url.split('#')[1] ?? '', (url.split('?')[1] ?? '').split('#')[0]];
  for (const part of parts) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const [k, v = ''] = pair.split('=');
      try {
        out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export default function ResetPasswordScreen() {
  const router = useRouter();
  const theme = useTheme();
  const url = Linking.useURL();
  const handled = useRef(false);

  const [phase, setPhase] = useState<Phase>('checking');
  const [problem, setProblem] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState({ password: false, confirm: false });
  const [error, setError] = useState<string | null>(null);

  async function startRecovery(p: Record<string, string>) {
    if (p.error || p.error_description) {
      setProblem(
        /expired|invalid/i.test(`${p.error_code ?? ''} ${p.error_description ?? ''}`)
          ? 'This reset link has expired or has already been used.'
          : 'This reset link didn’t work.',
      );
      setPhase('invalid');
      return;
    }
    // token_hash: the email links straight to joinphixr.com/reset-password (a universal
    // link, so it opens the app) and we verify here; older emails used code/access_token.
    const { error: sessionError } = p.token_hash
      ? await supabase.auth.verifyOtp({ token_hash: p.token_hash, type: 'recovery' })
      : p.code
      ? await supabase.auth.exchangeCodeForSession(p.code)
      : await supabase.auth.setSession({
          access_token: p.access_token,
          refresh_token: p.refresh_token ?? '',
        });
    if (sessionError) {
      setProblem('This reset link has expired or has already been used.');
      setPhase('invalid');
      return;
    }
    setPhase('ready');
  }

  // Start the recovery session from the link, once.
  useEffect(() => {
    if (handled.current) return;
    void (async () => {
      // The link may have arrived before this screen mounted (app already open), so also
      // check the root-level listener and the launch URL, not just useURL().
      const candidates = [url, latestIncomingUrl(), await Linking.getInitialURL()];
      const linkUrl = candidates.find((u): u is string => !!u && hasResetParams(linkParams(u)));
      if (!linkUrl || handled.current) return; // not the email link (yet)
      handled.current = true;
      await startRecovery(linkParams(linkUrl));
    })();
  }, [url]);

  // Opened without a usable link (e.g. typed in, or the link was stripped).
  useEffect(() => {
    if (phase !== 'checking') return;
    const t = setTimeout(() => {
      if (!handled.current) {
        setProblem('Open the reset link from your email on this phone to choose a new password.');
        setPhase('invalid');
      }
    }, 4000);
    return () => clearTimeout(t);
  }, [phase]);

  const passwordError = touched.password ? validatePassword(password) : null;
  const confirmError = touched.confirm ? validatePasswordConfirm(password, confirm) : null;

  async function onSave() {
    setTouched({ password: true, confirm: true });
    setError(null);
    if (validatePassword(password) || validatePasswordConfirm(password, confirm)) return;
    setPhase('saving');
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setPhase('ready');
      setError(
        /different from the old|same password/i.test(updateError.message)
          ? 'Your new password must be different from your old one.'
          : 'Couldn’t save your new password. Please try again.',
      );
      return;
    }
    Alert.alert('Password updated', 'You’re signed in with your new password.', [
      { text: 'OK', onPress: () => router.replace('/(tabs)') },
    ]);
  }

  if (phase === 'checking') {
    return (
      <AuthScreen title="Choose a new password" subtitle="Checking your reset link…">
        <View style={{ paddingVertical: 24 }}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      </AuthScreen>
    );
  }

  if (phase === 'invalid') {
    return (
      <AuthScreen
        title="Link not valid"
        subtitle={problem ?? 'This reset link didn’t work.'}
        onBack={() => router.replace('/(auth)/login')}
        footer={
          <Button title="Send a new link" onPress={() => router.replace('/(auth)/forgot-password')} />
        }>
        <FormMessage tone="error">Reset links work once and expire after an hour.</FormMessage>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      title="Choose a new password"
      subtitle="Pick something you haven’t used before."
      footer={<Button title="Save new password" onPress={onSave} loading={phase === 'saving'} />}>
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      <View style={{ gap: 8 }}>
        <TextField
          label="New password"
          value={password}
          onChangeText={setPassword}
          onBlur={() => setTouched((t) => ({ ...t, password: true }))}
          error={passwordError}
          hint="At least 10 characters."
          secureTextEntry
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          placeholder="Create a password"
        />
        <PasswordStrengthMeter password={password} />
      </View>
      <TextField
        label="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
        error={confirmError}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        textContentType="newPassword"
        placeholder="Re-enter your new password"
        returnKeyType="go"
        onSubmitEditing={onSave}
      />
    </AuthScreen>
  );
}
