import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { getAdsConsent, setAdsConsent } from '@/lib/ads';
import { useAuth } from '@/lib/auth-context';

/**
 * The UK GDPR/PECR ad-consent choice (brief 8D): a clear, equal choice shown
 * once to ADULTS who haven't decided, recorded with a timestamp server-side
 * and changeable any time in Settings. Minors never see it — they only ever
 * get non-personalised ads, with no choice to give away.
 */
export function AdsConsentPrompt() {
  const theme = useTheme();
  const { profile } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  const isAdult = profile?.age_band === 'adult';

  useEffect(() => {
    if (!isAdult) return;
    void getAdsConsent().then((c) => {
      if (c === 'unset') setVisible(true);
    });
  }, [isAdult]);

  if (!visible) return null;

  const choose = async (choice: 'personalised' | 'non_personalised') => {
    if (busy) return;
    setBusy(true);
    try {
      await setAdsConsent(choice);
      setVisible(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundSelected }]}>
      <ThemedText type="smallBold">Ads on Phixr</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Phixr shows a small number of ads. May we personalise them using your age group, area
        and interests? Either way you&apos;ll see the same amount — and you can change this any
        time in Settings.
      </ThemedText>
      <View style={styles.row}>
        <Button title="Personalise" onPress={() => void choose('personalised')} disabled={busy} />
        <Button
          title="Don't personalise"
          variant="secondary"
          onPress={() => void choose('non_personalised')}
          disabled={busy}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 8, padding: 14, borderRadius: 12, gap: 10 },
  row: { flexDirection: 'row', gap: 10 },
});
