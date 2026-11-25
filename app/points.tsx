import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getPointsHistory, POINTS_REASON_LABELS, type PointsHistoryRow } from '@/lib/points';
import { formatRelative } from '@/lib/relative-time';

/**
 * Points explainer — plain language, reachable from Profile and Analytics.
 *
 * Deliberately contains NO formulas and NO specific numbers (point values and the
 * distribution weighting are all still being tuned — see spec §8 "[OPEN] Tuning").
 * Hard-coding "a swipe is worth 1 point" here would go stale the moment those change.
 */
const EARNERS: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [
  { icon: 'albums-outline', text: 'Swiping through the deck — liking or skipping both count.' },
  { icon: 'chatbubble-outline', text: 'Commenting on posts and replying to other people.' },
  { icon: 'happy-outline', text: 'Reacting to comments.' },
  { icon: 'arrow-redo-outline', text: 'Sharing posts you think others should see.' },
  { icon: 'heart-outline', text: 'Getting comments on the posts you make.' },
];

const HISTORY_PAGE = 30;

export default function PointsExplainerScreen() {
  const theme = useTheme();
  const [history, setHistory] = useState<PointsHistoryRow[] | null>(null);
  const [done, setDone] = useState(false);
  const load = useCallback(async () => {
    try {
      const first = await getPointsHistory(null, HISTORY_PAGE);
      setHistory(first);
      setDone(first.length < HISTORY_PAGE);
    } catch {
      setHistory([]);
      setDone(true);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);
  const more = async () => {
    if (done || !history || history.length === 0) return;
    try {
      const next = await getPointsHistory(history[history.length - 1].created_at, HISTORY_PAGE);
      setHistory((prev) => [...(prev ?? []), ...next]);
      if (next.length < HISTORY_PAGE) setDone(true);
    } catch {
      // next tap retries
    }
  };
  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'How points work' }} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="title">Points are how your posts travel further.</ThemedText>
        <ThemedText type="default" themeColor="textSecondary">
          Phixr rewards taking part. The more you join in, the wider your own posts reach. Here&apos;s
          the whole idea, in plain English.
        </ThemedText>

        <Section title="What earns points">
          <View style={styles.earners}>
            {EARNERS.map((e) => (
              <View key={e.text} style={styles.earner}>
                <View style={[styles.iconWrap, { backgroundColor: theme.backgroundSelected }]}>
                  <Ionicons name={e.icon} size={18} color={BRAND.accent} />
                </View>
                <ThemedText type="default" style={styles.earnerText}>
                  {e.text}
                </ThemedText>
              </View>
            ))}
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            Real participation is what counts — rattling through cards as fast as possible
            won&apos;t earn you more.
          </ThemedText>
        </Section>

        <Section title="Points never expire">
          <ThemedText type="default" themeColor="textSecondary">
            Everything you earn is yours to keep. Your balance only ever goes up as you take part —
            it never decays and it never resets.
          </ThemedText>
        </Section>

        {/* Part 5A: a clear record of every earn and spend. */}
        <Section title="Your history">
          {history === null ? (
            <ActivityIndicator color={theme.textSecondary} />
          ) : history.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Nothing yet — points appear here as you take part.
            </ThemedText>
          ) : (
            <View style={styles.history}>
              {history.map((h, i) => (
                <View key={`${h.created_at}-${i}`} style={styles.historyRow}>
                  <View style={styles.historyText}>
                    <ThemedText type="default">
                      {POINTS_REASON_LABELS[h.reason] ?? h.reason}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {formatRelative(h.created_at)}
                    </ThemedText>
                  </View>
                  <ThemedText
                    type="smallBold"
                    style={{ color: h.delta >= 0 ? BRAND.accent : theme.textSecondary }}>
                    {h.delta >= 0 ? `+${h.delta}` : `${h.delta}`}
                  </ThemedText>
                </View>
              ))}
              {!done ? (
                <Pressable onPress={more} accessibilityRole="button" style={styles.moreBtn}>
                  <ThemedText type="smallBold" themeColor="textSecondary">
                    Show more
                  </ThemedText>
                </Pressable>
              ) : null}
            </View>
          )}
        </Section>

        <Section title="How your balance helps you">
          <ThemedText type="default" themeColor="textSecondary">
            A higher balance nudges your posts in front of more people. It&apos;s one of several
            signals — how well your post matches someone&apos;s interests and how fresh it is matter
            too — so points give you a lift rather than a guarantee. Keep taking part and your reach
            grows over time.
          </ThemedText>
        </Section>
      </ScrollView>
    </ThemedView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="subtitle">{title}</ThemedText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 24 },
  section: { gap: 10 },
  earners: { gap: 14 },
  earner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  history: { gap: 12 },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  historyText: { flex: 1, gap: 1 },
  moreBtn: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16 },
  iconWrap: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  earnerText: { flex: 1 },
  note: { marginTop: 4 },
});
