import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { BusinessOnly } from '@/components/business-only';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { formatCount } from '@/lib/format';
import { useAuth } from '@/lib/auth-context';
import { cancelBoost, getMyBoosts, type MyBoost } from '@/lib/boosts';
import { getBusinessInsights, type BusinessInsights } from '@/lib/business';
import { confirm } from '@/lib/confirm';
import { signMediaPaths } from '@/lib/media';
import {
  getAccountAnalytics,
  getCreatorOverview,
  getTagReach,
  type AccountAnalytics,
  type CreatorOverview,
  type OverviewPost,
  type TagReach,
} from '@/lib/profile';

export default function AnalyticsScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Analytics' }} />
      <BusinessOnly feature="Analytics">
        <AnalyticsScreenInner />
      </BusinessOnly>
    </>
  );
}

function AnalyticsScreenInner() {
  const theme = useTheme();
  const router = useRouter();
  const { user, profile } = useAuth();
  const isBusiness = (profile as { account_type?: string } | null)?.account_type === 'business';
  const [insights, setInsights] = useState<BusinessInsights | null>(null);
  const [account, setAccount] = useState<AccountAnalytics | null>(null);
  const [tags, setTags] = useState<TagReach[] | null>(null);
  const [overview, setOverview] = useState<CreatorOverview | null>(null);
  const [boosts, setBoosts] = useState<MyBoost[]>([]);
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const [a, t, o, b] = await Promise.all([
        getAccountAnalytics(),
        getTagReach(),
        getCreatorOverview(),
        getMyBoosts(10).catch(() => [] as MyBoost[]),
      ]);
      setAccount(a);
      setTags(t);
      setOverview(o);
      setBoosts(b);
      const paths = [o.best_post?.thumbnail_url, o.worst_post?.thumbnail_url].filter(
        (p): p is string => !!p,
      );
      if (paths.length > 0) setThumbs(await signMediaPaths(paths));
      if (isBusiness && user?.id) {
        setInsights(await getBusinessInsights(user.id, 30).catch(() => null));
      }
    } catch {
      setError(true);
    }
  }, [isBusiness, user?.id]);

  const stopBoost = async (b: MyBoost) => {
    if (!(await confirm('Stop this boost?', 'Unused whole days are refunded in points.', 'Stop'))) return;
    try {
      await cancelBoost(b.id);
      void load();
    } catch {
      // next refresh shows the truth
    }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader; sets loading/error state internally
    void load();
  }, [load]);

  if (error) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Analytics' }} />
        <ThemedText type="small" themeColor="textSecondary">
          Couldn&apos;t load analytics.
        </ThemedText>
        <Button title="Retry" variant="secondary" onPress={load} />
      </ThemedView>
    );
  }
  if (!account || !tags || !overview) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Analytics' }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  }

  const maxReach = Math.max(1, ...tags.map((t) => Number(t.reach)));
  const maxWeek = Math.max(1, ...account.follower_growth.map((w) => w.new_followers));
  const maxHour = Math.max(1, ...overview.hours.map((h) => h.swipes));

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Analytics' }} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Top-line numbers */}
        <View style={styles.statRow}>
          <BigStat label="Followers" value={account.follower_count} />
          <BigStat label="Posts" value={account.post_count} />
          <BigStat label="Total reach" value={account.total_reach} />
        </View>

        {/* LAST 7 / 28 DAYS (Part 3C) — tracked views, so recent activity only */}
        <Section title="Recent performance" subtitle="From tracked views over the last month.">
          <WindowRow label="Last 7 days" w={overview.week} />
          <WindowRow label="Last 28 days" w={overview.month} />
        </Section>

        {/* Best & worst recent posts, one tip each */}
        {overview.best_post ? (
          <Section title="What's working">
            <OverviewPostRow
              tag="Best"
              post={overview.best_post}
              thumb={thumbs.get(overview.best_post.thumbnail_url)}
              onPress={() => router.push(`/analytics/post/${overview.best_post!.post_id}`)}
            />
            {overview.worst_post ? (
              <OverviewPostRow
                tag="Needs love"
                post={overview.worst_post}
                thumb={thumbs.get(overview.worst_post.thumbnail_url)}
                onPress={() => router.push(`/analytics/post/${overview.worst_post!.post_id}`)}
              />
            ) : null}
          </Section>
        ) : null}

        {/* Boost results (Part 5B): extra views, likes and points per like */}
        {boosts.length > 0 ? (
          <Section title="Your boosts" subtitle="Views and likes during each boost window.">
            {boosts.map((b) => (
              <View key={b.id} style={[styles.boostRow, { borderColor: theme.border }]}>
                <View style={styles.boostInfo}>
                  <ThemedText type="smallBold">
                    {b.status === 'active' ? '● Running' : b.status === 'ended' ? 'Finished' : 'Stopped'}
                    {' · '}
                    {b.days} day{b.days === 1 ? '' : 's'} · {b.points_cost.toLocaleString()} pts
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {Number(b.window_views).toLocaleString()} views ·{' '}
                    {Number(b.window_likes).toLocaleString()} likes
                    {b.points_per_like != null ? ` · ${b.points_per_like} pts/like` : ''}
                  </ThemedText>
                </View>
                {b.status === 'active' ? (
                  <Button title="Stop" variant="secondary" onPress={() => void stopBoost(b)} />
                ) : null}
              </View>
            ))}
          </Section>
        ) : null}

        {/* Best time to post — audience swipe activity by hour, totals only */}
        {overview.hours.length > 0 && overview.top_hour != null ? (
          <Section
            title="Best time to post"
            subtitle={`Your audience is most active around ${formatHour(overview.top_hour)}.`}>
            <View style={styles.hourRow}>
              {overview.hours.map((h) => (
                <View key={h.hour} style={styles.hourCol}>
                  <View style={styles.hourBarWrap}>
                    <View
                      style={[
                        styles.hourBar,
                        {
                          height: `${(h.swipes / maxHour) * 100}%`,
                          backgroundColor:
                            h.hour === overview.top_hour ? BRAND.accent : theme.backgroundSelected,
                        },
                      ]}
                    />
                  </View>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.hourLabel}>
                    {h.hour}
                  </ThemedText>
                </View>
              ))}
            </View>
          </Section>
        ) : null}

        {/* TAG REACH — the most useful screen: which tags actually pull reach */}
        <Section
          title="Which tags pull reach"
          subtitle="Your tags ranked by the reach they've earned. Small samples are hidden.">
          {tags.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Not enough data yet — once your tagged posts get some swipes, the tags that pull reach
              show up here.
            </ThemedText>
          ) : (
            <View style={styles.bars}>
              {tags.map((t) => (
                <View key={t.tag} style={styles.barRow}>
                  <ThemedText type="small" style={styles.barLabel} numberOfLines={1}>
                    #{t.tag}
                  </ThemedText>
                  <View style={[styles.barTrack, { backgroundColor: theme.backgroundSelected }]}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          width: `${(Number(t.reach) / maxReach) * 100}%`,
                          backgroundColor: BRAND.accent,
                        },
                      ]}
                    />
                  </View>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.barValue}>
                    {t.reach}
                    {t.like_rate != null ? ` · ${Math.round(t.like_rate * 100)}% liked` : ''}
                  </ThemedText>
                </View>
              ))}
            </View>
          )}
        </Section>

        {/* Follower growth (aggregate weekly counts — never who) */}
        <Section title="Follower growth" subtitle="New followers per week.">
          {account.follower_growth.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              No followers yet.
            </ThemedText>
          ) : (
            <View style={styles.weekRow}>
              {account.follower_growth.slice(-12).map((w) => (
                <View key={w.week} style={styles.weekCol}>
                  <View style={styles.weekBarWrap}>
                    <View
                      style={[
                        styles.weekBar,
                        {
                          height: `${(w.new_followers / maxWeek) * 100}%`,
                          backgroundColor: BRAND.accent,
                        },
                      ]}
                    />
                  </View>
                  <ThemedText type="small" themeColor="textSecondary" style={styles.weekLabel}>
                    {new Date(w.week).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </ThemedText>
                </View>
              ))}
            </View>
          )}
        </Section>

        {/* Part 13E: business reach — daily-deduped counts only, never who */}
        {insights ? (
          <Section
            title="Your business"
            subtitle="Last 30 days. Each person counts once a day — never who, only how many.">
            <View style={styles.pointsRow}>
              <BigStat label="Profile views" value={insights.totals.profile_view ?? 0} />
              <BigStat label="Offer views" value={insights.totals.offer_view ?? 0} />
            </View>
            <View style={styles.pointsRow}>
              <BigStat label="Menu taps" value={insights.totals.menu_click ?? 0} />
              <BigStat label="Booking taps" value={insights.totals.booking_click ?? 0} />
            </View>
            {(insights.totals.hours_view ?? 0) > 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                {insights.totals.hours_view} people checked your opening hours.
              </ThemedText>
            ) : null}
          </Section>
        ) : null}

        {/* Points → distribution, in plain English */}
        <Section title="Points & distribution">
          <View style={styles.pointsRow}>
            <BigStat label="Balance" value={account.points_balance} />
            <BigStat label="Lifetime" value={account.points_lifetime} />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {pointsExplanation(account.points_balance, account.distribution_multiplier)}
          </ThemedText>
          <Button title="How points work" variant="secondary" onPress={() => router.push('/points')} />
        </Section>
      </ScrollView>
    </ThemedView>
  );
}

function pointsExplanation(balance: number, multiplier: number): string {
  if (balance <= 0) {
    return (
      'Your points give your posts a small nudge in how far they travel. Earn points by posting, ' +
      'commenting and getting engagement — the more you earn, the wider your posts reach.'
    );
  }
  const level = multiplier > 5 ? 'a strong' : multiplier > 4 ? 'a solid' : 'a modest';
  return (
    `Your ${balance.toLocaleString()} points currently give your posts ${level} reach boost. ` +
    'Points are one signal among your tags and how fresh a post is — earning more widens your distribution over time.'
  );
}

function formatHour(h: number): string {
  return `${h.toString().padStart(2, '0')}:00`;
}

function WindowRow({
  label,
  w,
}: {
  label: string;
  w: { views: number; like_rate: number | null; followers_gained: number; points_earned: number };
}) {
  return (
    <View style={styles.windowRow}>
      <ThemedText type="smallBold" style={styles.windowLabel}>
        {label}
      </ThemedText>
      <View style={styles.windowStats}>
        <MiniStat label="Views" text={w.views.toLocaleString()} />
        <MiniStat
          label="Liked"
          text={w.like_rate != null ? `${Math.round(w.like_rate * 100)}%` : '—'}
        />
        <MiniStat label="Followers" text={`+${w.followers_gained.toLocaleString()}`} />
        <MiniStat label="Points" text={`+${w.points_earned.toLocaleString()}`} />
      </View>
    </View>
  );
}

function MiniStat({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.miniStat}>
      <ThemedText type="subtitle">{text}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

function OverviewPostRow({
  tag,
  post,
  thumb,
  onPress,
}: {
  tag: string;
  post: OverviewPost;
  thumb?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${tag} post — view insights`}
      onPress={onPress}
      style={[styles.postRow, { borderColor: theme.border }]}>
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.postThumb} contentFit="cover" />
      ) : (
        <View style={[styles.postThumb, { backgroundColor: theme.backgroundSelected }]} />
      )}
      <View style={styles.postInfo}>
        <ThemedText type="smallBold">
          {tag} · {Math.round(post.like_rate * 100)}% liked · {post.views.toLocaleString()} views
        </ThemedText>
        {post.tip ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
            {post.tip}
          </ThemedText>
        ) : null}
      </View>
    </Pressable>
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

function BigStat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.bigStat}>
      <ThemedText type="title" style={styles.bigValue} numberOfLines={1} adjustsFontSizeToFit>
        {formatCount(Number(value))}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bigValue: { fontSize: 28, lineHeight: 34 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  content: { padding: 20, gap: 28 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  bigStat: { alignItems: 'center', gap: 2, flex: 1 },
  section: { gap: 6 },
  sectionBody: { marginTop: 8, gap: 10 },
  bars: { gap: 10 },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { width: 80 },
  barTrack: { flex: 1, height: 12, borderRadius: 6, overflow: 'hidden' },
  barFill: { height: 12, borderRadius: 6 },
  barValue: { width: 96, textAlign: 'right' },
  weekRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 120 },
  weekCol: { flex: 1, alignItems: 'center', gap: 4 },
  weekBarWrap: { flex: 1, width: '70%', justifyContent: 'flex-end' },
  weekBar: { width: '100%', borderRadius: 4, minHeight: 3 },
  weekLabel: { fontSize: 9 },
  pointsRow: { flexDirection: 'row', gap: 20, marginBottom: 6 },
  windowRow: { gap: 6 },
  windowLabel: { marginTop: 2 },
  windowStats: { flexDirection: 'row', justifyContent: 'space-between' },
  miniStat: { alignItems: 'center', gap: 2, flex: 1 },
  postRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 10,
  },
  postThumb: { width: 52, height: 52, borderRadius: 8 },
  postInfo: { flex: 1, gap: 2 },
  hourRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 90 },
  hourCol: { flex: 1, alignItems: 'center', gap: 4 },
  hourBarWrap: { flex: 1, width: '80%', justifyContent: 'flex-end' },
  hourBar: { width: '100%', borderRadius: 2, minHeight: 2 },
  hourLabel: { fontSize: 8 },
  boostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  boostInfo: { flex: 1, gap: 2 },
});
