import DateTimePicker from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { cancelSchedule, deleteDraft, listDrafts, postNow, scheduleDraft, type Draft } from '@/lib/drafts';
import { signMediaPaths } from '@/lib/media';

/**
 * Part 12A: the owner-only Drafts list. Media here is private draft media —
 * signed like all private-bucket objects, never visible to anyone else.
 */
export default function DraftsScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<(Draft & { thumb?: string })[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [when, setWhen] = useState<Date>(() => new Date(Date.now() + 60 * 60 * 1000));

  const load = useCallback(async () => {
    try {
      const drafts = await listDrafts();
      const thumbs = await signMediaPaths(
        drafts.map((d) => d.payload.media?.[0]?.thumbnail_url).filter(Boolean) as string[],
      );
      setRows(drafts.map((d) => ({
        ...d,
        thumb: d.payload.media?.[0]?.thumbnail_url
          ? thumbs.get(d.payload.media[0].thumbnail_url) ?? undefined
          : undefined,
      })));
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e) {
      Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  };

  const statusLine = (d: Draft): string => {
    if (d.status === 'scheduled' && d.scheduled_at)
      return `Scheduled for ${new Date(d.scheduled_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
    if (d.status === 'held') return 'Held for review — it will not publish until approved';
    if (d.status === 'failed') return `Failed: ${d.failure_reason ?? 'unknown reason'}`;
    if (d.autosave) return 'Auto-saved from the composer';
    return `Saved ${new Date(d.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Drafts' }} />
      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(d) => d.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
              No drafts yet. Save one from the composer and it syncs to every device
              you&apos;re signed in on.
            </ThemedText>
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { borderColor: theme.border }]}>
              <View style={styles.rowTop}>
                {item.thumb ? (
                  <Image source={{ uri: item.thumb }} style={styles.thumb} contentFit="cover" />
                ) : (
                  <View style={[styles.thumb, { backgroundColor: theme.backgroundSelected }]} />
                )}
                <View style={styles.body}>
                  <ThemedText type="smallBold" numberOfLines={2}>
                    {item.payload.caption?.trim() || (item.kind === 'story' ? 'Story draft' : 'Untitled draft')}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {statusLine(item)}
                  </ThemedText>
                </View>
              </View>
              <View style={styles.actions}>
                {item.status === 'scheduled' || item.status === 'held' ? (
                  <Button
                    title="Cancel schedule"
                    variant="secondary"
                    disabled={busy === item.id}
                    onPress={() => act(item.id, () => cancelSchedule(item.id))}
                  />
                ) : (
                  <Button
                    title="Schedule…"
                    variant="secondary"
                    disabled={busy === item.id || item.media_status === 'removed'}
                    onPress={() => setPickerFor(pickerFor === item.id ? null : item.id)}
                  />
                )}
                <Button
                  title="Post now"
                  disabled={busy === item.id || item.media_status !== 'approved'}
                  onPress={() => act(item.id, () => postNow(item.id))}
                />
                <Button
                  title="Delete"
                  variant="secondary"
                  disabled={busy === item.id}
                  onPress={() =>
                    Alert.alert('Delete draft?', 'This cannot be undone.', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => void act(item.id, () => deleteDraft(item.id)) },
                    ])
                  }
                />
              </View>
              {pickerFor === item.id ? (
                <View>
                  <DateTimePicker
                    value={when}
                    mode="datetime"
                    minimumDate={new Date()}
                    onChange={(_e, d) => {
                      if (d) setWhen(d);
                    }}
                  />
                  <Button
                    title="Confirm"
                    disabled={busy === item.id}
                    onPress={() => {
                      setPickerFor(null);
                      void act(item.id, () => scheduleDraft(item.id, when));
                    }}
                  />
                </View>
              ) : null}
            </View>
          )}
        />
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, textAlign: 'center' },
  list: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  rowTop: { flexDirection: 'row', gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 8 },
  body: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
