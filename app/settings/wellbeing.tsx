import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { getClientSettings } from '@/lib/settings';
import { getMyWellbeing, setMyWellbeing } from '@/lib/wellbeing';

/**
 * Part 14D: wellbeing — daily time reminder (on by default for teens),
 * quiet mode (notifications held + DM auto-reply, UK clock), and hiding
 * like counts. Quiet-hour muting and the auto-reply run server-side, so
 * they work even with the app closed.
 */

function toMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function toHHMM(min: number | null): string {
  if (min == null) return '';
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export default function WellbeingScreen() {
  const theme = useTheme();
  const { profile } = useAuth();
  const isMinor = (profile as { age_band?: string } | null)?.age_band === 'minor';

  const [loaded, setLoaded] = useState(false);
  const [teenDefault, setTeenDefault] = useState(45);
  const [reminder, setReminder] = useState('');
  const [quietOn, setQuietOn] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [autoReply, setAutoReply] = useState('');
  const [hideOthers, setHideOthers] = useState(false);
  const [hideMine, setHideMine] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [w, cs] = await Promise.all([getMyWellbeing(true), getClientSettings()]);
        const teen = Number((cs as Record<string, unknown>).teen_time_reminder_minutes) || 0;
        setTeenDefault(teen);
        setReminder(w.time_reminder_minutes ? String(w.time_reminder_minutes) : '');
        setQuietOn(w.quiet_start_min != null && w.quiet_end_min != null);
        if (w.quiet_start_min != null) setQuietStart(toHHMM(w.quiet_start_min));
        if (w.quiet_end_min != null) setQuietEnd(toHHMM(w.quiet_end_min));
        setAutoReply(w.quiet_auto_reply ?? '');
        setHideOthers(w.hide_like_counts_others);
        setHideMine(w.hide_like_counts_mine);
      } catch {
        // defaults stand
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const save = async () => {
    const start = toMin(quietStart);
    const end = toMin(quietEnd);
    if (quietOn && (start == null || end == null)) {
      Alert.alert('Check the times', 'Quiet hours look like 22:00 and 07:00.');
      return;
    }
    const mins = reminder.trim() ? parseInt(reminder, 10) : null;
    if (mins !== null && (!Number.isFinite(mins) || mins < 5 || mins > 480)) {
      Alert.alert('Check the reminder', 'Between 5 and 480 minutes, or leave it empty.');
      return;
    }
    setSaving(true);
    try {
      await setMyWellbeing({
        quiet_start_min: quietOn ? start : null,
        quiet_end_min: quietOn ? end : null,
        quiet_auto_reply: quietOn ? autoReply.trim() || null : null,
        time_reminder_minutes: mins,
        hide_like_counts_others: hideOthers,
        hide_like_counts_mine: hideMine,
      });
      Alert.alert('Saved');
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Wellbeing' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Wellbeing' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedText type="smallBold">Daily time reminder</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {isMinor && teenDefault > 0
            ? `A reminder after ${teenDefault} minutes a day is on for under-18s. Set your own number to change when it shows.`
            : 'A gentle note once you’ve been swiping this many minutes in a day. Leave empty for none.'}
        </ThemedText>
        <TextField
          label="Minutes per day"
          placeholder={isMinor && teenDefault > 0 ? String(teenDefault) : 'e.g. 45'}
          value={reminder}
          onChangeText={setReminder}
          keyboardType="number-pad"
        />

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <ThemedText type="smallBold">Quiet mode</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Notifications wait until morning (security alerts still come through), and
              DMs get your auto-reply.
            </ThemedText>
          </View>
          <Switch value={quietOn} onValueChange={setQuietOn} trackColor={{ true: BRAND.accent }} />
        </View>
        {quietOn ? (
          <>
            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <TextField label="From" placeholder="22:00" value={quietStart} onChangeText={setQuietStart} autoCapitalize="none" />
              </View>
              <View style={styles.timeField}>
                <TextField label="Until" placeholder="07:00" value={quietEnd} onChangeText={setQuietEnd} autoCapitalize="none" />
              </View>
            </View>
            <TextField
              label="DM auto-reply (optional)"
              placeholder="I'm away — back in the morning!"
              value={autoReply}
              onChangeText={setAutoReply}
            />
          </>
        ) : null}

        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <ThemedText type="smallBold">Hide like counts on other posts</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              You still like and skip as normal — you just don't see the numbers.
            </ThemedText>
          </View>
          <Switch value={hideOthers} onValueChange={setHideOthers} trackColor={{ true: BRAND.accent }} />
        </View>
        <View style={styles.switchRow}>
          <View style={styles.switchLabel}>
            <ThemedText type="smallBold">Hide like counts on my posts</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Viewers won't see your counts; your own analytics still do.
            </ThemedText>
          </View>
          <Switch value={hideMine} onValueChange={setHideMine} trackColor={{ true: BRAND.accent }} />
        </View>

        <Button title={saving ? 'Saving…' : 'Save'} onPress={() => void save()} disabled={saving} />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, gap: 12, paddingBottom: 48 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  switchLabel: { flex: 1, gap: 2 },
  timeRow: { flexDirection: 'row', gap: 10 },
  timeField: { flex: 1 },
});
