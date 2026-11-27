import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';

import { VideoOverlays } from '@/components/video-overlays';
import { parseVideoOverlays } from '@/lib/video-overlays';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { CollectionPicker } from '@/components/collection-picker';
import { CommentSheet } from '@/components/comments/comment-sheet';
import { FollowingEmpty } from '@/components/deck/following-empty';
import { HeartBurst } from '@/components/heart-burst';
import { StoriesRail } from '@/components/deck/stories-rail';
import { MentionText } from '@/components/mention-text';
import { ShareSheet } from '@/components/share-sheet';
import { SensitiveCover } from '@/components/sensitive-cover';
import { ThemedText } from '@/components/themed-text';
import { Avatar } from '@/components/ui/avatar';
import { BRAND, TAB_BAR_CLEARANCE } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getBookmarkState } from '@/lib/bookmarks';
import { fetchFollowingFeed, toggleFeedLike, type DeckCard } from '@/lib/deck';
import { formatCount } from '@/lib/format';
import { getExtrasForPosts, type PostMediaItem } from '@/lib/posts';
import { resolveDeckMedia } from '@/lib/media';
import { formatRelative } from '@/lib/relative-time';
import { getMuted, setMutedPreference, subscribeMute } from '@/lib/mute-preference';
import { cachedVideoUri } from '@/lib/video-cache';

const PAGE = 15;

/**
 * Persistent Instagram/TikTok-style feed for the Following tab: a scrollable list of
 * recent posts from accounts you follow, paginated, NOT consumed by swiping. The heart
 * (button or double tap) is a FEED like — its own counter, not a deck swipe, no points
 * (brief 2A); comment/share reuse the shared sheets.
 */
export function FollowingFeed() {
  const theme = useTheme();
  const [cards, setCards] = useState<DeckCard[] | null>(null); // null = first load
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [commentsFor, setCommentsFor] = useState<DeckCard | null>(null);
  const [shareFor, setShareFor] = useState<DeckCard | null>(null);
  const [extrasMap, setExtrasMap] = useState<Map<string, PostMediaItem[]>>(new Map());
  // Only posts actually on screen play their video — not every video the list has
  // rendered ahead (which used to stream several clips at once).
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const [viewabilityConfig] = useState(() => ({ itemVisiblePercentThreshold: 60 }));
  // FlatList needs this callback to keep the same identity for the list's lifetime.
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<DeckCard>[] }) => {
      setVisibleIds(new Set(viewableItems.map((v) => v.item?.id).filter(Boolean) as string[]));
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      const first = await resolveDeckMedia(await fetchFollowingFeed(null, PAGE));
      setCards(first);
      setAtEnd(first.length < PAGE);
      getExtrasForPosts(first.map((c) => c.id)).then(setExtrasMap).catch(() => {});
    } catch {
      setCards([]);
    }
  }, []);

  // Reload whenever the tab regains focus — so following someone from elsewhere
  // (e.g. a profile) makes their posts appear here without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const loadMore = useCallback(async () => {
    if (loadingMore || atEnd || !cards || cards.length === 0) return;
    setLoadingMore(true);
    try {
      const before = cards[cards.length - 1].created_at;
      const next = await resolveDeckMedia(await fetchFollowingFeed(before, PAGE));
      setCards((prev) => [...(prev ?? []), ...next]);
      if (next.length < PAGE) setAtEnd(true);
      getExtrasForPosts(next.map((c) => c.id))
        .then((m) => setExtrasMap((prev) => new Map([...prev, ...m])))
        .catch(() => {});
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }, [cards, loadingMore, atEnd]);

  const bumpComments = useCallback((id: string, d: number) => {
    setCards((prev) =>
      prev?.map((c) => (c.id === id ? { ...c, comment_count: Math.max(0, c.comment_count + d) } : c)) ?? prev,
    );
  }, []);

  if (cards === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.textSecondary} />
      </View>
    );
  }

  return (
    <>
      <FlatList
        data={cards}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={<StoriesRail />}
        ListEmptyComponent={<FollowingEmpty onReload={refresh} />}
        contentContainerStyle={{ paddingBottom: TAB_BAR_CLEARANCE }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.textSecondary} />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        renderItem={({ item }) => (
          <FeedCard
            card={item}
            active={visibleIds.has(item.id)}
            extras={extrasMap.get(item.id) ?? NO_EXTRAS}
            onOpenComments={() => setCommentsFor(item)}
            onOpenShare={() => setShareFor(item)}
          />
        )}
        ListFooterComponent={
          loadingMore ? (
            <ActivityIndicator style={{ padding: 16 }} color={theme.textSecondary} />
          ) : atEnd && cards.length > 0 ? (
            <View style={styles.caughtUp} accessibilityRole="text">
              <Ionicons name="checkmark-circle-outline" size={28} color={theme.textSecondary} />
              <ThemedText type="smallBold" themeColor="textSecondary">
                You&apos;re all caught up
              </ThemedText>
            </View>
          ) : null
        }
      />

      {commentsFor ? (
        <CommentSheet
          postId={commentsFor.id}
          postOwnerId={commentsFor.user_id}
          onClose={() => setCommentsFor(null)}
          onCountDelta={(d) => bumpComments(commentsFor.id, d)}
        />
      ) : null}
      {shareFor ? (
        <ShareSheet
          post={{ id: shareFor.id, caption: shareFor.caption }}
          allowExternal
          onClose={() => setShareFor(null)}
        />
      ) : null}
    </>
  );
}

const NO_EXTRAS: PostMediaItem[] = [];

const FeedCard = memo(function FeedCard({
  card,
  active,
  extras,
  onOpenComments,
  onOpenShare,
}: {
  card: DeckCard;
  /** On screen right now — only then does its video play. */
  active: boolean;
  extras: PostMediaItem[];
  onOpenComments: () => void;
  onOpenShare: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { width: winW } = useWindowDimensions();
  const [page, setPage] = useState(0);
  // Sensitive cover (6B): server never sends these to minors.
  const [revealed, setRevealed] = useState(false);
  // The heart reflects FEED likes only; the shown count is deck + feed likes
  // combined (a like is a like to viewers — creators see the split in analytics).
  const [liked, setLiked] = useState(Boolean(card.my_feed_like));
  const [likeCount, setLikeCount] = useState(card.like_count + (card.feed_like_count ?? 0));
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void getBookmarkState(card.id)
      .then((s) => alive && setSaved(s.saved))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [card.id]);

  // Heart toggle: a FEED like (post_likes), never a deck swipe. Optimistic; reverts on failure.
  const toggle = () => {
    const next = !liked;
    setLiked(next);
    setLikeCount((n) => Math.max(0, n + (next ? 1 : -1)));
    toggleFeedLike(card.id).catch(() => {
      setLiked(!next);
      setLikeCount((n) => Math.max(0, n + (next ? -1 : 1)));
    });
  };

  // Double-tapping the media likes (never unlikes), like Instagram. The heart
  // pops either way — the tap deserves visible feedback even when already liked (#68).
  const [burst, setBurst] = useState(0);
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .maxDuration(260)
    .runOnJS(true)
    .onEnd(() => {
      if (!liked) toggle();
      setBurst((n) => n + 1);
    });

  return (
    <View style={[styles.card, { borderBottomColor: theme.border }]}>
      <Pressable
        style={styles.header}
        onPress={() => router.push({ pathname: '/u/[handle]', params: { handle: card.poster_handle } })}
        accessibilityRole="button"
        accessibilityLabel={`Open @${card.poster_handle}`}>
        <Avatar uri={card.poster_avatar_url} name={card.poster_display_name} handle={card.poster_handle} size={38} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <ThemedText type="smallBold" numberOfLines={1}>
            {card.poster_display_name}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            @{card.poster_handle} · {formatRelative(card.created_at)}
          </ThemedText>
        </View>
      </Pressable>

      <GestureDetector gesture={doubleTap}>
      <View>
      {card.sensitive && !revealed ? <SensitiveCover onReveal={() => setRevealed(true)} /> : null}
      {extras.length === 0 ? (
        card.media_type === 'video' ? (
          <FeedVideo uri={card.media_url} overlays={card.overlays} active={active} />
        ) : (
          <Image
            source={{ uri: card.media_url }}
            style={styles.media}
            contentFit="cover"
            accessibilityLabel={card.alt_text ?? undefined}
          />
        )
      ) : (
        // Carousel: horizontal pager (cover + extras) with a counter pill + dots.
        <View>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onScroll={(e) => setPage(Math.round(e.nativeEvent.contentOffset.x / winW))}
            scrollEventThrottle={16}
            style={{ width: winW }}>
            {[{ media_url: card.media_url, media_type: card.media_type }, ...extras].map((m, i) => (
              <View key={i} style={{ width: winW }}>
                {m.media_type === 'video' ? (
                  <FeedVideo uri={m.media_url} active={active && page === i} />
                ) : (
                  <Image source={{ uri: m.media_url }} style={styles.media} contentFit="cover" />
                )}
              </View>
            ))}
          </ScrollView>
          <View style={styles.pagePill}>
            <ThemedText type="small" style={{ color: '#fff' }}>{page + 1}/{extras.length + 1}</ThemedText>
          </View>
          <View style={styles.dots}>
            {Array.from({ length: extras.length + 1 }).map((_, i) => (
              <View key={i} style={[styles.dot, { backgroundColor: i === page ? BRAND.accent : theme.backgroundSelected }]} />
            ))}
          </View>
        </View>
      )}
      <HeartBurst trigger={burst} />
      </View>
      </GestureDetector>

      <View style={styles.actions}>
        <Pressable onPress={toggle} hitSlop={8} style={styles.actionBtn} accessibilityRole="button" accessibilityLabel={liked ? 'Unlike' : 'Like'}>
          <Ionicons name={liked ? 'heart' : 'heart-outline'} size={24} color={liked ? BRAND.accent : theme.text} />
          <ThemedText type="smallBold">{formatCount(likeCount)}</ThemedText>
        </Pressable>
        <Pressable onPress={onOpenComments} hitSlop={8} style={styles.actionBtn} accessibilityRole="button" accessibilityLabel="Comments">
          <Ionicons name="chatbubble-outline" size={22} color={theme.text} />
          <ThemedText type="smallBold">{formatCount(card.comment_count)}</ThemedText>
        </Pressable>
        <Pressable onPress={onOpenShare} hitSlop={8} style={styles.actionBtn} accessibilityRole="button" accessibilityLabel="Share">
          <Ionicons name="paper-plane-outline" size={22} color={theme.text} />
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => setSaveOpen(true)} hitSlop={8} style={styles.actionBtn} accessibilityRole="button" accessibilityLabel={saved ? 'Saved — edit collection' : 'Save'}>
          <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={22} color={saved ? BRAND.accent : theme.text} />
        </Pressable>
      </View>

      {saveOpen ? (
        <CollectionPicker postId={card.id} visible={saveOpen} onClose={() => setSaveOpen(false)} onChange={setSaved} />
      ) : null}

      {card.caption ? (
        <MentionText type="default" style={styles.caption} numberOfLines={5}>
          {card.caption}
        </MentionText>
      ) : null}

      {card.location_label ? (
        <View style={styles.locationRow}>
          <Ionicons name="location-outline" size={13} color={theme.textSecondary} />
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {card.location_label}
          </ThemedText>
        </View>
      ) : null}

      {card.tags.length > 0 ? (
        <View style={styles.tagRow}>
          {card.tags.map((t) => (
            <Pressable
              key={t}
              onPress={() => router.push({ pathname: '/tag/[name]', params: { name: t } })}
              accessibilityRole="button"
              accessibilityLabel={`See the ${t} tag`}>
              <ThemedText type="small" style={{ color: theme.tint }}>
                #{t}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
});

function FeedVideo({ uri, overlays, active }: { uri: string; overlays?: unknown; active: boolean }) {
  const overlaysParsed = useMemo(() => parseVideoOverlays(overlays), [overlays]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // A copy downloaded ahead on Wi-Fi plays without the network; otherwise it streams.
  const source = useMemo(() => cachedVideoUri(uri), [uri]);
  // Same global, persisted mute preference as the Home deck: muted until the user
  // unmutes once, then that choice carries across cards, tabs and sessions.
  const [muted, setMuted] = useState(getMuted());
  const player = useVideoPlayer(source, (p) => {
    p.loop = true;
    p.muted = getMuted();
  });
  useEffect(() => subscribeMute((m) => {
    player.muted = m;
    setMuted(m);
  }), [player]);
  useEffect(() => {
    if (active) {
      // eslint-disable-next-line react-hooks/immutability -- expo-video's player is a mutable controller by design
      player.muted = getMuted();
      player.play();
    } else player.pause();
  }, [active, player]);
  function toggleMute() {
    const next = !muted;
    // eslint-disable-next-line react-hooks/immutability -- expo-video's player is a mutable controller by design
    player.muted = next;
    setMuted(next);
    setMutedPreference(next);
  }
  return (
    <View onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {/* pointerEvents="none": the native VideoView otherwise swallows taps above the JS
          layer (same fix as the Home deck), which would block the mute button. */}
      <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} pointerEvents="none" />
      <VideoOverlays overlays={overlaysParsed} width={box.w} height={box.h} />
      <Pressable
        onPress={toggleMute}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute video' : 'Mute video'}
        style={({ pressed }) => [styles.muteBadge, pressed && { opacity: 0.7 }]}>
        <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={16} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 12, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  media: { width: '100%', aspectRatio: 4 / 5, backgroundColor: '#111' },
  muteBadge: { position: 'absolute', bottom: 12, right: 12, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: 8 },
  pagePill: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 20, paddingHorizontal: 14, paddingTop: 10 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  caption: { paddingHorizontal: 14, paddingTop: 8 },
  caughtUp: { alignItems: 'center', gap: 6, paddingVertical: 28 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 14, paddingTop: 6 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 14, paddingTop: 6 },
});
