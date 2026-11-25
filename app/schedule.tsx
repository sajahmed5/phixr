import DateTimePicker from '@react-native-community/datetimepicker';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { cancelSchedule, listScheduled, postNow, scheduleDraft, type Draft } from '@/lib/drafts';
import { getCreatorOverview } from '@/lib/profile';

/**
 * Part 12B: the content calendar. A 14-day strip + per-day list; tap a
 * scheduled post for Move / Post now / Cancel (tap-to-move, signed off).
 * Best-time banner comes from the Part 3 audience hour histogram.
 */
export default function ScheduleScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [active, setActive] = useState<Draft | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [when, setWhen] = useState<Date>(new Date());
  const [bestHour, setBestHour] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listScheduled().then(setRows).catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    getCreatorOverview()
      .then((o) => {
        const top = (o as unknown as { top_hour?: number | null }).top_hour;
        if (typeof top === 'number') setBestHour(top);
      })
      .catch(() => {});
  }, [load]);

  const days = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; i < 14; i++) out.push(addDays(startOfDay(new Date()), i));
    return out;
  }, []);

  const byDay = useMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const r of rows ?? []) {
      if (!r.scheduled_at) continue;
      const k = startOfDay(new Date(r.scheduled_at)).toISOString();
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  }, [rows]);

  const dayRows = byDay.get(day.toISOString()) ?? [];

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setActive(null);
      setMoveOpen(false);
      load();
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Content calendar' }} />
      {bestHour !== null ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.best}>
          Your audience is most active around {bestHour}:00 — scheduling near then
          usually performs best.
        </ThemedText>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
        {days.map((d) => {
          const k = d.toISOString();
          const on = k === day.toISOString();
          const n = byDay.get(k)?.length ?? 0;
          return (
            <Pressable
              key={k}
              onPress={() => setDay(d)}
              accessibilityRole="button"
              style={[styles.dayChip, { borderColor: theme.border }, on && { backgroundColor: BRAND.accent, borderColor: BRAND.accent }]}>
              <ThemedText type="small" style={on ? { color: BRAND.onAccent } : undefined}>
                {d.toLocaleDateString('en-GB', { weekday: 'short' })}
              </ThemedText>
              <ThemedText type="smallBold" style={on ? { color: BRAND.onAccent } : undefined}>
                {d.getDate()}
              </ThemedText>
              {n > 0 ? <View style={[styles.dot, on && { backgroundColor: BRAND.onAccent }]} /> : null}
            </Pressable>
          );
        })}
      </ScrollView>

      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {dayRows.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
              Nothing scheduled for this day.
            </ThemedText>
          ) : (
            dayRows.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setActive(active?.id === r.id ? null : r)}
                accessibilityRole="button"
                style={[styles.card, { borderColor: theme.border }]}>
                <ThemedText type="smallBold" numberOfLines={1}>
                  {r.scheduled_at
                    ? new Date(r.scheduled_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                    : ''}{' '}
                  · {r.kind === 'story' ? 'Story' : 'Post'}
                  {r.status === 'held' ? '  (held for review)' : r.status === 'failed' ? '  (failed)' : ''}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                  {r.payload.caption?.trim() || 'No caption'}
                </ThemedText>
                {r.status === 'failed' && r.failure_reason ? (
                  <ThemedText type="small" style={{ color: BRAND.accent }}>
                    {r.failure_reason}
                  </ThemedText>
                ) : null}
                {active?.id === r.id ? (
                  <View style={styles.actions}>
                    <Button title="Move…" variant="secondary" disabled={busy} onPress={() => {
                      setWhen(r.scheduled_at ? new Date(r.scheduled_at) : new Date());
                      setMoveOpen(true);
                    }} />
                    <Button title="Post now" disabled={busy} onPress={() => void act(() => postNow(r.id))} />
                    <Button title="Cancel" variant="secondary" disabled={busy}
                      onPress={() => void act(() => cancelSchedule(r.id))} />
                  </View>
                ) : null}
                {active?.id === r.id && moveOpen ? (
                  <View>
                    <DateTimePicker
                      value={when}
                      mode="datetime"
                      minimumDate={new Date()}
                      onChange={(_e, d) => {
                        if (d) setWhen(d);
                      }}
                    />
                    <Button title="Confirm move" disabled={busy}
                      onPress={() => void act(() => scheduleDraft(r.id, when))} />
                  </View>
                ) : null}
              </Pressable>
            ))
          )}
        </ScrollView>
      )}
    </ThemedView>
  );
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, textAlign: 'center' },
  best: { paddingHorizontal: 16, paddingTop: 10 },
  strip: { flexGrow: 0, paddingHorizontal: 12, paddingVertical: 10 },
  dayChip: {
    alignItems: 'center', borderWidth: 1, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 4, gap: 2,
  },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: BRAND.accent },
  list: { padding: 16, gap: 10 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
