import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AccountSwitcher } from '@/components/account-switcher';
import { HighlightsRail, ProfileLinksRow } from '@/components/profile/showcase-sections';
import { ProfileHeader } from '@/components/profile/profile-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { VerifyEmailBanner } from '@/components/verify-email-banner';
import { BRAND, TAB_BAR_CLEARANCE } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { isBusinessProfile } from '@/lib/account-type';
import { useAuth } from '@/lib/auth-context';
import { getBookmarks, getCollections, type Collection, type SavedPost } from '@/lib/bookmarks';
import { getMySwipes, undoSwipe, type SwipedPost } from '@/lib/deck';
import {
  getPendingRequestCount,
  getProfileOverview,
  getProfilePosts,
  type GridPost,
  type ProfileOverview,
} from '@/lib/profile';
import { useOutbox } from '@/lib/outbox-provider';
import { shareProfile } from '@/lib/share';

type Tab = 'posts' | 'liked' | 'skipped' | 'saved';
type Cell = { id: string; thumbnail_url: string; media_type: 'image' | 'video'; media_count?: number };

export default function ProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { profile: authProfile, user } = useAuth();
  const handle = authProfile?.handle;
  const isBusiness = isBusinessProfile(authProfile);

  const [overview, setOverview] = useState<ProfileOverview | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('posts');
  const [posts, setPosts] = useState<GridPost[] | null>(null);
  const [liked, setLiked] = useState<SwipedPost[] | null>(null);
  const [skipped, setSkipped] = useState<SwipedPost[] | null>(null);
  const [saved, setSaved] = useState<SavedPost[] | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [savedFilter, setSavedFilter] = useState<string | null>(null); // null = All saved
  const [requestCount, setRequestCount] = useState(0);
  const [headError, setHeadError] = useState(false);

  const load = useCallback(async () => {
    if (!handle) return;
    setHeadError(false);
    try {
      const ov = await getProfileOverview(handle);
      setOverview(ov);
      if (ov) {
        setPosts(await getProfilePosts(ov.id).catch(() => []));
      }
    } catch {
      setHeadError(true);
    }
    setRequestCount(await getPendingRequestCount());
  }, [handle]);

  const loadSwipes = useCallback(async (t: 'liked' | 'skipped') => {
    try {
      const rows = await getMySwipes(t === 'liked' ? 'right' : 'left');
      if (t === 'liked') setLiked(rows);
      else setSkipped(rows);
    } catch {
      if (t === 'liked') setLiked([]);
      else setSkipped([]);
    }
  }, []);

  const loadSaved = useCallback(async (filter: string | null) => {
    try {
      setSaved(await getBookmarks(filter));
    } catch {
      setSaved([]);
    }
  }, []);

  // Refetch the active tab whenever it becomes active — never show stale data
  // (this is a persistent tab screen, so state survives navigating away and back).
  const tabRef = useRef<Tab>('posts');
  const filterRef = useRef<string | null>(null);
  useEffect(() => {
    tabRef.current = tab;
    filterRef.current = savedFilter;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async loaders; set state on resolve
    if (tab === 'liked' || tab === 'skipped') void loadSwipes(tab);
    else if (tab === 'saved') {
      void getCollections().then(setCollections).catch(() => setCollections([]));
      void loadSaved(savedFilter);
    }
  }, [tab, loadSwipes, loadSaved, savedFilter]);

  // Also refresh on focus (e.g. after saving in the deck, then returning here).
  useFocusEffect(
    useCallback(() => {
      void load();
      if (tabRef.current === 'liked' || tabRef.current === 'skipped') void loadSwipes(tabRef.current);
      else if (tabRef.current === 'saved') {
        void getCollections().then(setCollections).catch(() => setCollections([]));
        void loadSaved(filterRef.current);
      }
    }, [load, loadSwipes, loadSaved]),
  );

  if (!overview) {
    return (
      <ThemedView style={styles.center}>
        {headError ? (
          <ThemedText type="small" themeColor="textSecondary">
            Couldn&apos;t load your profile.
          </ThemedText>
        ) : (
          <ActivityIndicator color={theme.textSecondary} />
        )}
      </ThemedView>
    );
  }

  const goConnections = (type: 'followers' | 'following') =>
    router.push({
      pathname: '/connections',
      params: { userId: overview.id, type, title: overview.handle },
    });

  const cells: Cell[] =
    tab === 'posts'
      ? (posts ?? []).map((p) => ({ id: p.id, thumbnail_url: p.thumbnail_url, media_type: p.media_type, media_count: p.media_count }))
      : tab === 'saved'
        ? (saved ?? []).map((s) => ({ id: s.id, thumbnail_url: s.thumbnail_url, media_type: s.media_type }))
        : (tab === 'liked' ? liked ?? [] : skipped ?? []).map((s) => ({
            id: s.post_id,
            thumbnail_url: s.thumbnail_url,
            media_type: s.media_type,
          }));
  const loading =
    tab === 'posts' ? posts === null : tab === 'liked' ? liked === null : tab === 'skipped' ? skipped === null : saved === null;
  const emptyText =
    tab === 'posts'
      ? "You haven't posted yet."
      : tab === 'liked'
        ? "You haven't liked anything yet."
        : tab === 'skipped'
          ? "You haven't skipped anything yet."
          : savedFilter === null
            ? "You haven't saved anything yet."
            : 'Nothing saved in this collection yet.';

  const undo = async (postId: string) => {
    try {
      await undoSwipe(postId);
      if (tab === 'liked') setLiked((p) => p?.filter((x) => x.post_id !== postId) ?? p);
      else setSkipped((p) => p?.filter((x) => x.post_id !== postId) ?? p);
    } catch {
      /* ignore */
    }
  };

  const gap = 2;
  const size = (width - gap * 2) / 3;

  const listHeader = (
    <>
      <VerifyEmailBanner />
      <ProfileHeader
        profile={overview}
        points={authProfile?.points_balance ?? 0}
        onPressPoints={() => router.push('/points')}
        onPressIdentity={() => setSwitcherOpen(true)}
        category={(authProfile as { category?: string | null } | null)?.category ?? null}
        onPressFollowers={() => goConnections('followers')}
        onPressFollowing={() => goConnections('following')}
        action={
          <View style={styles.actionsBlock}>
            <View style={styles.actions}>
              <PillButton label="Edit profile" onPress={() => router.push('/profile/edit')} />
              <PillButton
                label="Share profile"
                onPress={() => void shareProfile(overview.handle, overview.display_name)}
              />
              {overview.is_private || requestCount > 0 ? (
                <IconPill
                  icon="person-add-outline"
                  label="Follow requests"
                  badge={requestCount}
                  onPress={() => router.push('/profile/requests')}
                />
              ) : null}
            </View>
            {isBusiness ? (
              <Pressable
                onPress={() => router.push('/business-tools')}
                accessibilityRole="button"
                accessibilityLabel="Open business tools"
                style={({ pressed }) => [
                  styles.toolsCard,
                  { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.75 : 1 },
                ]}>
                <View style={[styles.toolsIcon, { backgroundColor: BRAND.accent }]}>
                  <Ionicons name="briefcase" size={16} color={BRAND.onAccent} />
                </View>
                <View style={styles.toolsText}>
                  <ThemedText type="smallBold">Business tools</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                    Analytics, drafts, scheduling, promotions and earnings
                  </ThemedText>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
              </Pressable>
            ) : null}
          </View>
        }
      />
      {user?.id ? (
        <View style={styles.showcase}>
          {isBusiness ? <ProfileLinksRow userId={user.id} /> : null}
          <HighlightsRail userId={user.id} isOwner />
        </View>
      ) : null}
      <QueuedPostsStrip onPress={() => router.push('/drafts')} />
      <View style={[styles.tabs, { borderTopColor: theme.border, borderBottomColor: theme.border }]}>
        <TabButton icon="grid-outline" active={tab === 'posts'} onPress={() => setTab('posts')} label="Posts" />
        <TabButton icon="heart-outline" active={tab === 'liked'} onPress={() => setTab('liked')} label="Liked" />
        <TabButton icon="close-circle-outline" active={tab === 'skipped'} onPress={() => setTab('skipped')} label="Skipped" />
        <TabButton icon="bookmark-outline" active={tab === 'saved'} onPress={() => setTab('saved')} label="Saved" />
      </View>
      {tab === 'saved' ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label="All" active={savedFilter === null} onPress={() => setSavedFilter(null)} theme={theme} />
          <Chip label="Manage…" active={false} onPress={() => router.push('/collections')} theme={theme} />
          {collections.map((c) => (
            <Chip
              key={c.id}
              label={`${c.name}${c.item_count ? ` ${c.item_count}` : ''}`}
              active={savedFilter === c.id}
              onPress={() => setSavedFilter(c.id)}
              theme={theme}
            />
          ))}
        </ScrollView>
      ) : null}
    </>
  );

  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={cells}
        keyExtractor={(c, i) => `${tab}:${c.id}:${i}`}
        numColumns={3}
        columnWrapperStyle={{ gap }}
        contentContainerStyle={{ gap, paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <View style={styles.emptyBox}>
            {loading ? (
              <ActivityIndicator color={theme.textSecondary} />
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                {emptyText}
              </ThemedText>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/post/${item.id}`)}
            style={{ width: size, height: size }}
            accessibilityRole="button"
            accessibilityLabel="Open post">
            <Image source={{ uri: item.thumbnail_url }} style={styles.thumb} contentFit="cover" recyclingKey={item.id} />
            {item.media_type === 'video' ? (
              <View style={[styles.badge, styles.vidBadge]}>
                <Ionicons name="videocam" size={12} color="#fff" />
              </View>
            ) : null}
            {(item.media_count ?? 1) > 1 ? (
              <View style={[styles.badge, styles.vidBadge]}>
                <Ionicons name="copy" size={12} color="#fff" />
              </View>
            ) : null}
            {tab === 'liked' || tab === 'skipped' ? (
              <Pressable
                onPress={() => undo(item.id)}
                hitSlop={6}
                style={[styles.badge, styles.undo]}
                accessibilityRole="button"
                accessibilityLabel={tab === 'liked' ? 'Unlike' : 'Un-skip'}>
                <Ionicons name="arrow-undo" size={13} color="#fff" />
              </Pressable>
            ) : null}
          </Pressable>
        )}
      />
      <AccountSwitcher visible={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </ThemedView>
  );
}

function TabButton({
  icon,
  active,
  onPress,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  label: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}>
      <Ionicons name={icon} size={22} color={active ? BRAND.accent : theme.textSecondary} />
      <View style={[styles.tabUnderline, { backgroundColor: active ? BRAND.accent : 'transparent' }]} />
    </Pressable>
  );
}

function Chip({
  label,
  active,
  onPress,
  theme,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  theme: ReturnType<typeof useTheme>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={[
        styles.chip,
        { borderColor: active ? BRAND.accent : theme.border, backgroundColor: active ? BRAND.accent : 'transparent' },
      ]}>
      <ThemedText type="small" style={{ color: active ? BRAND.onAccent : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/** Equal-width rounded button for the main profile actions (Edit / Share). */
function PillButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
      ]}>
      <ThemedText type="smallBold" numberOfLines={1}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/** Square icon button that sits beside the pills (e.g. follow requests, with a count). */
function IconPill({
  icon,
  label,
  onPress,
  badge,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  badge?: number;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      style={({ pressed }) => [
        styles.iconPill,
        { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.7 : 1 },
      ]}>
      <Ionicons name={icon} size={18} color={theme.text} />
      {badge ? (
        <View style={styles.iconBadge}>
          <ThemedText type="small" style={styles.badgeText}>
            {badge > 99 ? '99+' : badge}
          </ThemedText>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Posts made without signal, waiting to upload — so they're visible on your profile. */
function QueuedPostsStrip({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  const { posts } = useOutbox();
  const waiting = posts.filter((p) => p.status === 'waiting' || p.status === 'sending');
  const failed = posts.filter((p) => p.status === 'failed' || p.status === 'rejected');
  if (waiting.length === 0 && failed.length === 0) return null;
  const text = failed.length
    ? `${failed.length} post${failed.length === 1 ? '' : 's'} couldn’t be uploaded`
    : `${waiting.length} post${waiting.length === 1 ? '' : 's'} waiting to upload`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[styles.queueStrip, { backgroundColor: theme.backgroundElement }]}>
      <Ionicons
        name={failed.length ? 'alert-circle-outline' : 'cloud-upload-outline'}
        size={18}
        color={failed.length ? theme.danger : theme.textSecondary}
      />
      <ThemedText type="small" style={{ flex: 1 }}>
        {text}
      </ThemedText>
      <Ionicons name="chevron-forward" size={16} color={theme.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  actionsBlock: { gap: 10 },
  actions: { flexDirection: 'row', gap: 8 },
  pill: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  iconPill: { width: 44, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  iconBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    backgroundColor: BRAND.accent,
    borderRadius: 999,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  toolsCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 12 },
  toolsIcon: { width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  toolsText: { flex: 1, gap: 1 },
  showcase: { gap: 12, paddingBottom: 6 },
  queueStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
  },
  badgeText: { color: BRAND.onAccent, fontWeight: '700' },
  tabs: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: 6 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingTop: 12, gap: 10 },
  tabUnderline: { height: 2, width: '55%', borderRadius: 1 },
  emptyBox: { paddingVertical: 48, alignItems: 'center' },
  thumb: { width: '100%', height: '100%', backgroundColor: '#111' },
  badge: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 4 },
  vidBadge: { top: 4, left: 4 },
  undo: { top: 4, right: 4 },
});
