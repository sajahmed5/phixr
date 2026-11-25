import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Share, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import {
  confirmEnrol,
  generateBackupCodes,
  getMySecurity,
  recoverWithBackupCode,
  startEnrol,
  type SecurityStatus,
} from '@/lib/security';

/**
 * Part 14C: two-step login. Authenticator app (TOTP) + one-time backup
 * codes; SMS backup arrives once the SMS provider is configured. Required
 * for team admins and accounts with earnings; strongly encouraged for
 * creators, businesses and advertisers.
 */
export default function SecurityScreen() {
  const theme = useTheme();
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [enrol, setEnrol] = useState<{ factorId: string; secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [recoverCode, setRecoverCode] = useState('');
  const [showRecover, setShowRecover] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getMySecurity());
    } catch {
      setStatus({ mfa_enrolled: false, backup_codes_left: 0, mfa_required: false });
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const begin = async () => {
    setBusy(true);
    try {
      setEnrol(await startEnrol());
    } catch (e) {
      Alert.alert("Couldn't start setup", e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!enrol || code.trim().length < 6) return;
    setBusy(true);
    try {
      await confirmEnrol(enrol.factorId, code);
      setEnrol(null);
      setCode('');
      const fresh = await generateBackupCodes();
      setCodes(fresh);
      void load();
    } catch (e) {
      Alert.alert('That code didn’t match', e instanceof Error ? e.message : 'Check your authenticator app and try again.');
    } finally {
      setBusy(false);
    }
  };

  const newCodes = async () => {
    const go = await new Promise<boolean>((resolve) =>
      Alert.alert('New backup codes?', 'Your old unused codes stop working.', [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Generate', onPress: () => resolve(true) },
      ]),
    );
    if (!go) return;
    try {
      setCodes(await generateBackupCodes());
      void load();
    } catch (e) {
      Alert.alert("Couldn't generate codes", e instanceof Error ? e.message : 'Please try again.');
    }
  };

  const recover = async () => {
    setBusy(true);
    try {
      await recoverWithBackupCode(recoverCode);
      setShowRecover(false);
      setRecoverCode('');
      Alert.alert('Authenticator removed', 'Set up two-step login again with your new device.');
      void load();
    } catch {
      Alert.alert("That code didn't work", 'Backup codes are one-time and look like ABC12-DE345.');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Security' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Security' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedText type="smallBold">Two-step login</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          A 6-digit code from an authenticator app protects your account even if your
          password leaks.{' '}
          {status.mfa_required
            ? 'Your account requires it (team admin or earnings).'
            : 'Strongly recommended for creators, businesses and advertisers.'}
        </ThemedText>

        {status.mfa_enrolled ? (
          <>
            <ThemedText type="small" style={styles.okLine}>
              ✓ Two-step login is on
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Backup codes left: {status.backup_codes_left}. Each works once if you lose
              your authenticator.
            </ThemedText>
            <Button title="Generate new backup codes" variant="secondary" onPress={() => void newCodes()} />
            <Button
              title="Lost your authenticator?"
              variant="secondary"
              onPress={() => setShowRecover((v) => !v)}
            />
          </>
        ) : enrol ? (
          <>
            <ThemedText type="small" themeColor="textSecondary">
              1. Add this key in your authenticator app (Google Authenticator, 1Password, Authy…):
            </ThemedText>
            <View style={[styles.secretBox, { borderColor: theme.border }]}>
              <ThemedText type="smallBold" selectable style={styles.mono}>
                {enrol.secret}
              </ThemedText>
            </View>
            <Button
              title="Share / copy key"
              variant="secondary"
              onPress={() => void Share.share({ message: enrol.secret })}
            />
            <ThemedText type="small" themeColor="textSecondary">
              2. Enter the 6-digit code it shows:
            </ThemedText>
            <TextField label="Code" placeholder="123456" value={code} onChangeText={setCode} keyboardType="number-pad" />
            <Button title={busy ? 'Checking…' : 'Turn on two-step login'} onPress={() => void confirm()} disabled={busy || code.trim().length < 6} />
          </>
        ) : (
          <Button title={busy ? 'Starting…' : 'Set up two-step login'} onPress={() => void begin()} disabled={busy} />
        )}

        {codes ? (
          <View style={[styles.codesBox, { borderColor: theme.border }]}>
            <ThemedText type="smallBold">Your backup codes — save them now</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              This is the only time they're shown. Each works once.
            </ThemedText>
            {codes.map((c) => (
              <ThemedText key={c} type="small" selectable style={styles.mono}>
                {c}
              </ThemedText>
            ))}
            <Button
              title="Share / copy codes"
              variant="secondary"
              onPress={() => void Share.share({ message: codes.join('\n') })}
            />
            <Button title="I've saved them" onPress={() => setCodes(null)} />
          </View>
        ) : null}

        {showRecover ? (
          <View style={[styles.codesBox, { borderColor: theme.border }]}>
            <ThemedText type="small" themeColor="textSecondary">
              Enter one unused backup code. Your authenticator is removed so you can set
              up a new one.
            </ThemedText>
            <TextField label="Backup code" placeholder="ABC12-DE345" value={recoverCode} onChangeText={setRecoverCode} autoCapitalize="characters" />
            <Button title={busy ? 'Checking…' : 'Use backup code'} onPress={() => void recover()} disabled={busy || recoverCode.trim().length < 8} />
          </View>
        ) : null}

        <ThemedText type="smallBold" style={styles.subhead}>Login alerts</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          We tell you whenever your account signs in on a new device — even during quiet
          hours. If it wasn't you, the alert has a one-tap "This wasn't me" that signs out
          every device and emails you a password reset.
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 10, paddingBottom: 48 },
  subhead: { marginTop: 16 },
  okLine: { color: '#2E7D46' },
  secretBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12 },
  codesBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6, marginTop: 10 },
  mono: { fontVariant: ['tabular-nums'], letterSpacing: 1 },
});
