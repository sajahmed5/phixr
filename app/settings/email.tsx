import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import { changeEmail, getLoginEmail } from '@/lib/profile';
import { validateEmail } from '@/lib/validation';

/**
 * Settings → Login details → Email. Shows the current login email and starts a change.
 * Both the old and the new address get a confirmation link; the switch happens only when
 * both are tapped, so an unlocked phone alone can't move the account to someone else.
 */
export default function ChangeEmailScreen() {
  const theme = useTheme();
  const [current, setCurrent] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    getLoginEmail()
      .then(({ email, pending: waiting }) => {
        setCurrent(email);
        setPending(waiting);
      })
      .catch(() => setError('Couldn’t load your account. Check your connection and try again.'))
      .finally(() => setLoading(false));
  }, []);

  async function send(address: string) {
    if (saving) return;
    const value = address.trim().toLowerCase();
    const invalid = validateEmail(value);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (current && value === current.toLowerCase()) {
      setError('That’s already your login email.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await changeEmail(value);
      setSentTo(value);
      setPending(value);
      setNext('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t start the change. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Email' }} />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {loading ? (
            <ActivityIndicator color={theme.textSecondary} style={{ marginTop: 24 }} />
          ) : (
            <>
              <View style={styles.block}>
                <ThemedText type="small" themeColor="textSecondary">
                  Current login email
                </ThemedText>
                <ThemedText type="default" style={styles.email}>{current ?? "—"}</ThemedText>
              </View>

              {sentTo ? (
                <FormMessage tone="success">
                  {`Check your inbox. We’ve sent a link to ${sentTo} and to ${current}. Tap both to finish. Until then you still log in with ${current}.`}
                </FormMessage>
              ) : pending ? (
                <View style={styles.block}>
                  <FormMessage tone="info">
                    {`Waiting for you to confirm ${pending}. Tap the links we emailed to both addresses. Until then you still log in with ${current}.`}
                  </FormMessage>
                  <Button
                    title="Resend the links"
                    variant="secondary"
                    onPress={() => void send(pending)}
                    loading={saving}
                  />
                </View>
              ) : null}

              <TextField
                label="New email"
                value={next}
                onChangeText={(v) => {
                  setNext(v);
                  setError(null);
                  setSentTo(null);
                }}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                textContentType="emailAddress"
                inputMode="email"
                placeholder="you@example.com"
                returnKeyType="send"
                onSubmitEditing={() => void send(next)}
              />
              {error ? <FormMessage tone="error">{error}</FormMessage> : null}
              <Button title="Send confirmation links" onPress={() => void send(next)} loading={saving} />
              <ThemedText type="small" themeColor="textSecondary">
                For your security we confirm with both addresses, so the change only happens once
                you’ve tapped the link in each.
              </ThemedText>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 16 },
  block: { gap: 6 },
  email: { fontWeight: '600' },
});
