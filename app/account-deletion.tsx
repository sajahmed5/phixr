import { Stack, useRouter } from 'expo-router';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { SUPPORT_EMAIL } from '@/constants/config';
import { useAuth } from '@/lib/auth-context';

/**
 * Public "how to delete your Phixr account" page (joinphixr.com/account-deletion).
 * Google Play requires a web link where people can ask for their account and data to be
 * deleted without reinstalling the app; the App Store listing can use it too. Readable
 * without signing in. Wording follows the Privacy Policy's retention section.
 */
export default function AccountDeletionScreen() {
  const router = useRouter();
  const { status } = useAuth();
  const signedIn = status === 'ready';

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Delete your account' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="subtitle">Delete your Phixr account</ThemedText>

        <ThemedText type="smallBold">In the app or on the web</ThemedText>
        <View style={styles.steps}>
          <ThemedText>1. Sign in to Phixr (the app, or joinphixr.com).</ThemedText>
          <ThemedText>2. Go to Settings → Delete account.</ThemedText>
          <ThemedText>3. Confirm twice. Your account is deleted straight away.</ThemedText>
        </View>
        {signedIn ? (
          <Button title="Go to Settings" variant="secondary" onPress={() => router.push('/settings')} />
        ) : (
          <Button title="Sign in to delete" variant="secondary" onPress={() => router.push('/(auth)/login')} />
        )}

        <ThemedText type="smallBold">Can’t sign in?</ThemedText>
        <ThemedText>
          Email {SUPPORT_EMAIL} from the email address on your account with the subject “Delete my
          account” and your handle. We’ll confirm it’s you and delete the account within 30 days.
        </ThemedText>
        <Button
          title={`Email ${SUPPORT_EMAIL}`}
          variant="outline"
          onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20account`)}
        />

        <ThemedText type="smallBold">What gets deleted</ThemedText>
        <ThemedText>
          Your profile, posts, photos, videos, stories, comments, messages, likes, follows, points,
          settings and everything else linked to your account. Backup copies clear on a rolling basis
          shortly after.
        </ThemedText>

        <ThemedText type="smallBold">What we keep, and for how long</ThemedText>
        <ThemedText>
          • Billing, payout and tax records: as long as the law requires (usually six years).{'\n'}
          • Moderation and safety records: as long as needed to keep Phixr safe and meet our legal
          duties.{'\n'}
          • Evidence of serious crime, such as child sexual abuse material: preserved for law
          enforcement as the law requires.{'\n'}
          • Crash reports and analytics: deleted automatically after a limited period.
        </ThemedText>

        <ThemedText type="small" themeColor="textSecondary">
          Want a copy of your data first? Use Settings → Export my data before deleting. Full details are
          in our Privacy Policy.
        </ThemedText>
        <Button title="Read the Privacy Policy" variant="outline" onPress={() => router.push('/legal/privacy')} />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center' },
  steps: { gap: 4 },
});
