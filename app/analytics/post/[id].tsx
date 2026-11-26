import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { formatCount } from '@/lib/format';
import { getPostInsights, type PostInsights } from '@/lib/profile';

/**
 * Per-post insights (Part 3, brief 3B): the creator opens this and knows in
 * five seconds what worked. One big headline, drop-off for videos, audience
 * aggregates (the server enforces the under-18 and 50-person protections —
 * nothing here ever sees an individual), and one plain-English tip.
 */
export default function PostInsightsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const [data, setData] = useState<PostInsights | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      setData(await getPostInsights(id));
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader; sets loading/error state internally
    void load();
  }, [load]);

  if (error) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Post insights' }} />
        <ThemedText type="small" themeColor="textSecondary">
          Couldn&apos;t load insights.
        </ThemedText>
        <Button title="Retry" variant="secondary" onPress={load} />
      </ThemedView>
    );
  }
  if (!data) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Post insights' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  const likedPct = data.like_rate != null ? Math.round(data.like_rate * 100) : null;
  const video = data.watch.video_views > 0;
  const maxWatching = Math.max(1, ...data.watch.dropoff.map((d) => d.watching));

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Post insights' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* THE headline: one number, one comparison. */}
        {likedPct != null ? (
          <View style={styles.headline}>
            <ThemedText style={styles.headlineNumber}>{likedPct}% liked it</ThemedText>
            {data.better_than != null && data.recent_count > 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                Better than {data.better_than} of your last {data.recent_count} post
                {data.recent_count === 1 ? '' : 's'}
              </ThemedText>
            ) : null}
          </View>
        ) : (
          <View style={styles.headline}>
            <ThemedText type="subtitle">Not enough swipes yet</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              The headline appears after a few more people see this post.
            </ThemedText>
          </View>
        )}

        {/* Counts — feed hearts deliberately separate from deck likes (2A). */}
        <View style={styles.statRow}>
          <Stat label="Deck likes" value={data.deck_likes} />
          <Stat label="Skips" value={data.deck_skips} />
          <Stat label="Feed hearts" value={data.feed_likes} />
          <Stat label="Comments" value={data.comments} />
          <Stat label="Reach" value={data.reach} />
        </View>

        {!data.enough_views ? (
          <View style={[styles.notice, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="small" themeColor="textSecondary">
              Not enough views yet. Check back after {data.min_views} views for watch time and
              audience details.
            </ThemedText>
          </View>
        ) : null}

        {/* Watch behaviour (tracked views only). */}
        {data.watch.views > 0 ? (
          <Section title="How people watched">
            <View style={styles.statRow}>
              <Stat
                label="Avg time"
                text={formatSeconds((data.watch.avg_dwell_ms ?? 0) / 1000)}
              />
              <Stat
                label="Quick skips"
                text={
                  data.watch.quick_skip_rate != null
                    ? `${Math.round(data.watch.quick_skip_rate * 100)}%`
                    : '—'
                }
              />
              {video ? (
                <Stat
                  label="Watched to end"
                  text={
                    data.watch.completion_rate != null
                      ? `${Math.round(data.watch.completion_rate * 100)}%`
                      : '—'
                  }
                />
              ) : null}
            </View>

            {video && data.watch.dropoff.length > 0 ? (
              <>
                <View style={styles.dropoffRow}>
                  {data.watch.dropoff.map((d) => (
                    <View key={d.sec} style={styles.dropoffCol}>
                      <View style={styles.dropoffBarWrap}>
                        <View
                          style={[
                            styles.dropoffBar,
                            {
                              height: `${(d.watching / maxWatching) * 100}%`,
                              backgroundColor: BRAND.accent,
                            },
                          ]}
                        />
                      </View>
                      <ThemedText type="small" themeColor="textSecondary" style={styles.dropLabel}>
                        {formatSeconds(d.sec)}
                      </ThemedText>
                    </View>
                  ))}
                </View>
                {data.watch.dropoff_peak_sec != null ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    Most people skipped at {formatSeconds(data.watch.dropoff_peak_sec)}.
                  </ThemedText>
                ) : null}
              </>
            ) : null}
          </Section>
        ) : null}

        {/* Audience — server-side aggregates only; small groups arrive as "Other". */}
        {data.audience.likers > 0 ? (
          <Section
            title="Who liked it"
            subtitle="Aggregates only — groups under the privacy minimum show as Other.">
            <BreakdownRows
              rows={[
                ...data.audience.age_bands.map((b) => ({ label: b.band, n: b.likes })),
                ...(data.audience.under18_likes != null
                  ? [{ label: 'Under 18', n: data.audience.under18_likes }]
                  : []),
              ]}
            />
            {data.audience.regions.length > 0 ? (
              <>
                <ThemedText type="smallBold" style={styles.subhead}>
                  By area
                </ThemedText>
                <BreakdownRows
                  rows={data.audience.regions.map((r) => ({ label: r.region, n: r.likes }))}
                />
              </>
            ) : null}
            {data.audience.interests.length > 0 ? (
              <>
                <ThemedText type="smallBold" style={styles.subhead}>
                  Top interests
                </ThemedText>
                <BreakdownRows
                  rows={data.audience.interests.map((t) => ({ label: `#${t.tag}`, n: t.likes }))}
                />
              </>
            ) : null}
          </Section>
        ) : null}

        {/* One tip, never harsh. */}
        {data.tip ? (
          <View style={[styles.tipCard, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold">Tip</ThemedText>
            <ThemedText>{data.tip}</ThemedText>
          </View>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

function formatSeconds(s: number): string {
  const whole = Math.max(0, Math.round(s));
  const m = Math.floor(whole / 60);
  const sec = whole % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function Stat({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="subtitle" style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
        {text ?? formatCount(Number(value ?? 0))}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" numberOfLines={2} style={styles.statLabel}>
        {label}
      </ThemedText>
    </View>
  );
}

function BreakdownRows({ rows }: { rows: { label: string; n: number }[] }) {
  const theme = useTheme();
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <View style={styles.bars}>
      {rows.map((r) => (
        <View key={r.label} style={styles.barRow}>
          <ThemedText type="small" style={styles.barLabel} numberOfLines={1}>
            {r.label}
          </ThemedText>
          <View style={[styles.barTrack, { backgroundColor: theme.backgroundSelected }]}>
            <View
              style={[
                styles.barFill,
                { width: `${(r.n / max) * 100}%`, backgroundColor: BRAND.accent },
              ]}
            />
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.barValue}>
            {r.n.toLocaleString()}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="subtitle">{title}</ThemedText>
      {subtitle ? (
        <ThemedText type="small" themeColor="textSecondary">
          {subtitle}
        </ThemedText>
      ) : null}
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  statValue: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  statLabel: { textAlign: 'center' },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  content: { padding: 20, gap: 24 },
  headline: { alignItems: 'center', gap: 4, paddingVertical: 8 },
  headlineNumber: { fontSize: 40, lineHeight: 48, fontWeight: '700' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { alignItems: 'center', gap: 2, flex: 1 },
  notice: { borderRadius: 10, padding: 12 },
  section: { gap: 6 },
  sectionBody: { marginTop: 8, gap: 10 },
  subhead: { marginTop: 8 },
  dropoffRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 110 },
  dropoffCol: { flex: 1, alignItems: 'center', gap: 4 },
  dropoffBarWrap: { flex: 1, width: '70%', justifyContent: 'flex-end' },
  dropoffBar: { width: '100%', borderRadius: 4, minHeight: 3 },
  dropLabel: { fontSize: 9 },
  bars: { gap: 10 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { width: 86 },
  barTrack: { flex: 1, height: 12, borderRadius: 6, overflow: 'hidden' },
  barFill: { height: 12, borderRadius: 6 },
  barValue: { width: 64, textAlign: 'right' },
  tipCard: { borderRadius: 12, padding: 14, gap: 4 },
});
