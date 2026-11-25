import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { listAccounts } from '@/lib/accounts';
import { useAuth } from '@/lib/auth-context';
import { getClientSettings, settingNumber } from '@/lib/settings';
import { supabase } from '@/lib/supabase';

/**
 * Part 11: add another account to this device. Signing in here does NOT
 * sign anything out — the current account's session stays in the device
 * vault and shows in the switcher. "Create a new account" releases the
 * active session (the vault keeps it) and runs the normal signup flow.
 */
export default function AddAccountScreen() {
  const router = useRouter();
  const { reload } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guardLimit = async (): Promise<boolean> => {
    const [accounts, settings] = await Promise.all([listAccounts(), getClientSettings()]);
    const max = settingNumber(settings, 'max_linked_accounts', 5);
    if (accounts.length >= max) {
      setError(`You can be signed in to up to ${max} accounts on one device.`);
      return false;
    }
    return true;
  };

  const signInExisting = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await guardLimit())) return;
      const existing = await listAccounts();
      // The vault holds the current account already; signing in swaps the
      // ACTIVE session only. If it fails, the previous session is untouched.
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err || !data.session) {
        setError('Wrong email or password.');
        return;
      }
      if (existing.some((a) => a.user_id === data.session!.user.id)) {
        // Already linked — this just became a switch.
      }
      reload();
      router.dismissTo('/');
    } finally {
      setBusy(false);
    }
  };

  const createNew = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await guardLimit())) return;
      // Release ONLY the live session — the vault still holds every account,
      // so they all reappear in the switcher after signup completes.
      await supabase.auth.signOut();
      router.replace('/(auth)/signup/account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <View style={styles.body}>
        <ThemedText type="small" themeColor="textSecondary">
          Sign in to another Phixr account. Your current accounts stay signed in on this
          device — switch between them from your profile.
        </ThemedText>
        <TextField
          label="Email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextField
          label="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <Button
          title={busy ? 'Signing in…' : 'Sign in'}
          onPress={signInExisting}
          disabled={busy || !email.trim() || !password}
        />
        <Button title="Create a new account instead" variant="secondary" onPress={createNew} disabled={busy} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 20, gap: 14 },
});
