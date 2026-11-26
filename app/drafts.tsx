import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { useOnline } from '@/lib/connectivity';
import { cancelSchedule, deleteDraft, listDrafts, postNow, scheduleDraft, type Draft } from '@/lib/drafts';
import { signMediaPaths } from '@/lib/media';
import { useOutbox } from '@/lib/outbox-provider';
import type { QueuedPost } from '@/lib/post-outbox';

/**
 * Part 12A: the owner-only Drafts list. Media here is private draft media —
 * signed like all private-bucket objects, never visible to anyone else.
 */
export default function DraftsScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<(Draft & { thumb?: string })[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [when, setWhen] = useState<Date>(() => new Date(Date.now() + 60 * 60 * 1000));
  const { posts: queued, retryPost, removePost } = useOutbox();
  const online = useOnline();
  const waiting = queued.filter((p) => p.status !== 'done');

  const load = useCallback(async () => {
    try {
      setLoadFailed(false);
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
      setLoadFailed(true);
    }
  }, []);
  // Reload when the connection returns, and when an offline draft has just been saved to
  // the server (it moves from the "waiting" section into the main list).
  const savedOfflineDrafts = queued.filter((p) => p.intent === 'draft' && p.status === 'done').length;
  useEffect(() => {
    void load();
  }, [load, online, savedOfflineDrafts]);

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
      {rows === null && waiting.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={rows ?? []}
          keyExtractor={(d) => d.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            waiting.length > 0 ? (
              <View style={styles.waitingSection}>
                {waiting.map((p) => (
                  <QueuedPostCard
                    key={p.id}
                    item={p}
                    online={online}
                    onRetry={() => retryPost(p.id)}
                    onDelete={() =>
                      Alert.alert(
                        p.intent === 'post' ? 'Discard this post?' : 'Discard this draft?',
                        "It hasn't been uploaded yet, so it will be gone for good.",
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Discard', style: 'destructive', onPress: () => removePost(p.id) },
                        ],
                      )
                    }
                  />
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            loadFailed && !online ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
                You&apos;re offline. Drafts saved to your account will show here when
                you&apos;re back online.
              </ThemedText>
            ) : waiting.length > 0 ? null : (
              <ThemedText type="small" themeColor="textSecondary" style={styles.pad}>
                No drafts yet. Save one from the composer and it syncs to every device
                you&apos;re signed in on.
              </ThemedText>
            )
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

/** A post or draft made without signal, held on this phone until it can be uploaded. */
function QueuedPostCard({
  item,
  online,
  onRetry,
  onDelete,
}: {
  item: QueuedPost;
  online: boolean;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const cover = item.media[0];
  let line: string;
  let icon: keyof typeof Ionicons.glyphMap = 'time-outline';
  let tone: 'textSecondary' | 'danger' = 'textSecondary';
  if (item.status === 'sending') {
    icon = 'cloud-upload-outline';
    line = `Uploading… ${Math.round(item.progress * 100)}%`;
  } else if (item.status === 'rejected' || item.status === 'failed') {
    icon = 'alert-circle-outline';
    tone = 'danger';
    line = item.error ?? "This couldn't be uploaded.";
  } else if (!online) {
    line =
      item.intent === 'post'
        ? 'Waiting for connection — posts automatically when you’re back online'
        : 'Waiting for connection — saves to your drafts when you’re back online';
  } else {
    line = item.intent === 'post' ? 'Getting ready to post…' : 'Getting ready to save…';
  }
  return (
    <View style={[styles.card, { borderColor: theme.border }]}>
      <View style={styles.rowTop}>
        {cover?.type === 'image' ? (
          <Image source={{ uri: cover.uri }} style={styles.thumb} contentFit="cover" />
        ) : (
          <View style={[styles.thumb, styles.videoThumb, { backgroundColor: theme.backgroundSelected }]}>
            <Ionicons name="videocam" size={22} color={theme.textSecondary} />
          </View>
        )}
        <View style={styles.body}>
          <ThemedText type="smallBold" numberOfLines={2}>
            {item.draft.caption.trim() || (item.intent === 'post' ? 'Untitled post' : 'Untitled draft')}
          </ThemedText>
          <View style={styles.statusRow}>
            <Ionicons name={icon} size={14} color={tone === 'danger' ? theme.danger : theme.textSecondary} />
            <ThemedText type="small" themeColor={tone} style={{ flex: 1 }}>
              {line}
            </ThemedText>
          </View>
        </View>
      </View>
      <View style={styles.actions}>
        {item.status === 'failed' ? <Button title="Try again" onPress={onRetry} /> : null}
        {item.status !== 'sending' ? (
          <Button title="Discard" variant="secondary" onPress={onDelete} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  waitingSection: { gap: 12, marginBottom: 12 },
  videoThumb: { alignItems: 'center', justifyContent: 'center' },
  statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 24, textAlign: 'center' },
  list: { padding: 16, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  rowTop: { flexDirection: 'row', gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 8 },
  body: { flex: 1, gap: 2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
