import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Linking from 'expo-linking';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import {
  approveConsent,
  describeConsent,
  redirectWith,
  SCOPE_TEXT,
  type ApiScope,
  type ConsentRequest,
} from '@/lib/connected-apps';

/**
 * "Connect to Phixr" — the OAuth 2.0 consent screen outside apps (Metricool, Buffer,
 * our Zapier app…) send people to:
 *
 *   https://joinphixr.com/oauth/authorize?response_type=code&client_id=…
 *     &redirect_uri=…&scope=posts:write%20account:read&state=…
 *     &code_challenge=…&code_challenge_method=S256
 *
 * The signed-in person picks which business account to connect (their own, or one
 * they're an admin of), sees in plain words what the app can do, and allows or
 * cancels. Allow → back to the app's redirect_uri with ?code=…&state=…; the app swaps
 * the code for tokens at the API's /oauth/token endpoint.
 *
 * If the request itself is bad (unknown app, unregistered redirect URL) we show an
 * error here and never redirect, as OAuth requires.
 */

const WONT_DO = 'It can’t read your messages, see who you follow, like or comment, or change your settings.';

function errorText(code: string): string {
  switch (code) {
    case 'unknown_app':
      return 'This app isn’t registered with Phixr, or has been suspended.';
    case 'bad_redirect_uri':
      return 'This app sent you here from an address it hasn’t registered with Phixr, so we stopped for your safety.';
    case 'invalid_scope':
      return 'This app asked for a permission Phixr doesn’t offer.';
    case 'bad_request':
      return 'This link is missing information. Go back to the app and try connecting again.';
    default:
      return code;
  }
}

function goTo(url: string) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(url);
  else void Linking.openURL(url);
}

export default function AuthorizeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const p = useLocalSearchParams<{
    response_type?: string;
    client_id?: string;
    redirect_uri?: string;
    scope?: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
  }>();
  const scopes = useMemo(
    () => (p.scope ?? '').split(/[\s+,]+/).map((s) => s.trim()).filter(Boolean),
    [p.scope],
  );

  const [req, setReq] = useState<ConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (p.response_type !== 'code' || !p.client_id || !p.redirect_uri || scopes.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- validating route params
      setError('bad_request');
      return;
    }
    let live = true;
    describeConsent(p.client_id, p.redirect_uri, scopes)
      .then((r) => {
        if (!live) return;
        setReq(r);
        const first = r.accounts.find((a) => a.eligible);
        setChosen(first?.id ?? null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [p.response_type, p.client_id, p.redirect_uri, scopes]);

  const cancel = () => {
    if (req && p.redirect_uri) {
      setDone(true);
      goTo(redirectWith(p.redirect_uri, { error: 'access_denied', state: p.state }));
    } else if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  const allow = async () => {
    if (!req || !chosen || !p.client_id || !p.redirect_uri) return;
    setBusy(true);
    try {
      const code = await approveConsent({
        clientId: p.client_id,
        redirectUri: p.redirect_uri,
        scopes,
        businessId: chosen,
        codeChallenge: p.code_challenge ?? null,
        codeChallengeMethod: p.code_challenge_method ?? null,
      });
      setDone(true);
      goTo(redirectWith(p.redirect_uri, { code, state: p.state }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const header = <Stack.Screen options={{ headerShown: true, title: 'Connect an app' }} />;

  if (error) {
    return (
      <ThemedView style={styles.fill}>
        {header}
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={44} color={theme.danger} />
          <ThemedText type="subtitle" style={styles.centerText}>
            Can’t connect this app
          </ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.centerText}>
            {errorText(error)}
          </ThemedText>
          <Button title="Back to Phixr" variant="secondary" onPress={() => router.replace('/(tabs)')} />
        </View>
      </ThemedView>
    );
  }

  if (!req || done) {
    return (
      <ThemedView style={styles.fill}>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
          {done ? (
            <ThemedText themeColor="textSecondary" style={styles.centerText}>
              Taking you back to {req?.app.name ?? 'the app'}…
            </ThemedText>
          ) : null}
        </View>
      </ThemedView>
    );
  }

  const testing = req.app.status !== 'live';
  const eligible = req.accounts.filter((a) => a.eligible);

  return (
    <ThemedView style={styles.fill}>
      {header}
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.appRow}>
          {req.app.logo_url ? (
            <Image source={{ uri: req.app.logo_url }} style={styles.logo} contentFit="cover" />
          ) : (
            <View style={[styles.logo, styles.logoFallback, { backgroundColor: theme.backgroundElement }]}>
              <Ionicons name="apps-outline" size={26} color={theme.text} />
            </View>
          )}
          <Ionicons name="swap-horizontal" size={22} color={theme.textSecondary} />
          <View style={[styles.logo, styles.logoFallback, { backgroundColor: BRAND.accent }]}>
            <Ionicons name="images-outline" size={26} color={BRAND.onAccent} />
          </View>
        </View>

        <ThemedText type="subtitle" style={styles.centerText}>
          {req.app.name} wants to connect to Phixr
        </ThemedText>
        {req.app.description ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            {req.app.description}
          </ThemedText>
        ) : null}

        {testing ? (
          <View style={[styles.notice, { backgroundColor: theme.backgroundElement }]}>
            <Ionicons name="flask-outline" size={18} color={theme.text} />
            <ThemedText type="small" style={{ flex: 1 }}>
              This app is still being tested. It can only connect its developer’s test accounts, and
              anything it “posts” is a practice run that never appears on Phixr.
            </ThemedText>
          </View>
        ) : null}

        <ThemedText type="smallBold">Which account?</ThemedText>
        <View style={[styles.card, { borderColor: theme.border }]}>
          {req.accounts.map((a) => {
            const selected = chosen === a.id;
            return (
              <Pressable
                key={a.id}
                disabled={!a.eligible}
                onPress={() => setChosen(a.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !a.eligible }}
                style={[styles.row, !a.eligible && { opacity: 0.5 }]}>
                <Avatar uri={a.avatar_url} name={a.display_name} handle={a.handle} size={36} />
                <View style={{ flex: 1 }}>
                  <ThemedText type="default">{a.display_name || `@${a.handle}`}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {a.reason === 'not_business'
                      ? `@${a.handle} · needs a business account (Settings → Business account)`
                      : a.reason === 'app_in_test_mode'
                        ? `@${a.handle} · not a tester for this app`
                        : a.connected
                          ? `@${a.handle} · already connected (this will update it)`
                          : `@${a.handle}`}
                  </ThemedText>
                </View>
                <Ionicons
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={selected ? BRAND.accent : theme.textSecondary}
                />
              </Pressable>
            );
          })}
        </View>

        <ThemedText type="smallBold">{req.app.name} will be able to:</ThemedText>
        <View style={styles.list}>
          {req.scopes.map((s) => (
            <View key={s} style={styles.bullet}>
              <Ionicons name="checkmark-circle" size={18} color={BRAND.accent} />
              <ThemedText type="small" style={{ flex: 1 }}>
                {SCOPE_TEXT[s as ApiScope] ?? s}
              </ThemedText>
            </View>
          ))}
          <View style={styles.bullet}>
            <Ionicons name="close-circle-outline" size={18} color={theme.textSecondary} />
            <ThemedText type="small" themeColor="textSecondary" style={{ flex: 1 }}>
              {WONT_DO}
            </ThemedText>
          </View>
        </View>

        <ThemedText type="small" themeColor="textSecondary">
          Posts it makes still go through Phixr’s safety checks, and you’re responsible for them under
          the Business & Creator Terms. You can remove this app at any time in Settings → Connected apps.
          {req.app.website_url ? `\n\nApp website: ${req.app.website_url}` : ''}
          {req.app.privacy_url ? `\nPrivacy policy: ${req.app.privacy_url}` : ''}
        </ThemedText>

        {!req.adult ? (
          <ThemedText type="small" style={{ color: theme.danger }}>
            You must be 18 or over to connect apps.
          </ThemedText>
        ) : eligible.length === 0 ? (
          <ThemedText type="small" style={{ color: theme.danger }}>
            None of your accounts can connect this app yet.
          </ThemedText>
        ) : null}

        <View style={styles.actions}>
          <Button
            title="Allow"
            onPress={allow}
            loading={busy}
            disabled={!chosen || !req.adult || eligible.length === 0}
          />
          <Button title="Cancel" variant="secondary" onPress={cancel} disabled={busy} />
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 14, maxWidth: 560, width: '100%', alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  centerText: { textAlign: 'center' },
  appRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 8 },
  logo: { width: 56, height: 56, borderRadius: 14 },
  logoFallback: { alignItems: 'center', justifyContent: 'center' },
  notice: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, alignItems: 'flex-start' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  list: { gap: 8 },
  bullet: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  actions: { gap: 10, marginTop: 6 },
});
