import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { CollectionPicker } from '@/components/collection-picker';
import { ShareSheet } from '@/components/share-sheet';
import { CommentSheet } from '@/components/comments/comment-sheet';
import { HeartBurst } from '@/components/heart-burst';
import { MentionText } from '@/components/mention-text';
import { PostAnalyticsCard } from '@/components/profile/post-analytics-card';
import { SensitiveCover } from '@/components/sensitive-cover';
import { VideoOverlays } from '@/components/video-overlays';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ActionMenu } from '@/components/ui/action-menu';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { confirmReported, POST_REPORT_REASONS } from '@/lib/reports';
import { isBusinessProfile } from '@/lib/account-type';
import { useAuth } from '@/lib/auth-context';
import { getPartnershipLabels } from '@/lib/partnerships';
import {
  getCollaborators,
  inviteCollaborator,
  leaveCollab,
  respondCollab,
  setPostPinned,
  type Collaborator,
} from '@/lib/showcase';
import { getBookmarkState } from '@/lib/bookmarks';
import { fetchComments, type CommentView } from '@/lib/comments';
import { parseVideoOverlays } from '@/lib/video-overlays';
import { confirm } from '@/lib/confirm';
import { recordSwipe, undoSwipe } from '@/lib/deck';
import { formatCount } from '@/lib/format';
import {
  deletePost,
  getMyPosts,
  getPostDetail,
  getPostExtras,
  getVideoCaptions,
  reportPost,
  setVideoCaptions,
  type PostDetail,
  type PostMediaItem,
} from '@/lib/posts';
import { getProfilePosts } from '@/lib/profile';
import { downloadOwnPostMedia } from '@/lib/share';

/** How many comments to show inline before "View all". Two fits without pushing the
 *  rest of the post off-screen. */
const COMMENT_PREVIEW = 2;

/** Instagram's display bounds: 4:5 at the tallest, 1.91:1 at the widest (#62). */
const clampAspect = (w: number, h: number) =>
  w > 0 && h > 0 ? Math.min(1.91, Math.max(4 / 5, w / h)) : 4 / 5;

export default function PostViewScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { user, profile } = useAuth();
  const isBusiness = isBusinessProfile(profile);
  // `nav` is set only by goToSibling: 'back' makes the replace animate as a pop, so
  // swiping to the previous post slides the way the finger moved (#39).
  const { id, nav } = useLocalSearchParams<{ id: string; nav?: string }>();
  const { width: winW } = useWindowDimensions();
  const pageW = winW - 32; // styles.content horizontal padding
  const [post, setPost] = useState<PostDetail | null>(null);
  const [ownerMenu, setOwnerMenu] = useState(false);
  const [collabInviteOpen, setCollabInviteOpen] = useState(false);
  const [collabHandle, setCollabHandle] = useState('');
  const [extras, setExtras] = useState<PostMediaItem[]>([]);
  const [preview, setPreview] = useState<CommentView[]>([]);
  const [page, setPage] = useState(0);
  // #62: images render at their natural shape (clamped) instead of a forced 4:5
  // cover-crop, which was cutting subjects out of the full view that the grid
  // thumbnail still showed. A carousel takes its cover's ratio for every page so
  // the pager keeps one height. Null until the (cached) source reports its size.
  const [aspect, setAspect] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentCount, setCommentCount] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  // Sensitive cover (6B): server never serves sensitive posts to minors.
  const [revealed, setRevealed] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  // Part 14E: share (audience-gated), download-own, video captions.
  const [shareOpen, setShareOpen] = useState(false);
  const [captions, setCaptions] = useState<string | null>(null);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [captionsDraft, setCaptionsDraft] = useState('');
  // Local like/skip state so the viewer can toggle (like ↔ unlike, skip ↔ un-skip).
  const [myDir, setMyDir] = useState<'left' | 'right' | null>(null);
  const [likeCount, setLikeCount] = useState(0);
  const [skipCount, setSkipCount] = useState(0);
  /** Your own post ids in grid order, so you can step between them from here (#18). */
  const [siblings, setSiblings] = useState<string[]>([]);

  const isOwner = !!post && post.user_id === user?.id;
  const posterId = post?.user_id ?? null;
  useEffect(() => {
    if (post?.media_type === 'video') {
      void getVideoCaptions(post.id)
        .then(setCaptions)
        .catch(() => {});
    }
  }, [post?.id, post?.media_type]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror of loaded post
    setPinned(!!(post as unknown as { pinned_at?: string | null })?.pinned_at);
  }, [post]);
  useEffect(() => {
    // #63: on someone else's post their visible grid becomes the browse set — the
    // same fetch the profile screen uses, so RLS has already filtered out anything
    // this viewer isn't allowed to see.
    if (!posterId) return;
    let alive = true;
    const ids = isOwner
      ? getMyPosts().then((rows) => rows.map((r) => r.id))
      : getProfilePosts(posterId).then((rows) => rows.map((r) => r.id));
    void ids.then((list) => alive && setSiblings(list)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOwner, posterId]);

  const siblingIndex = id ? siblings.indexOf(id) : -1;
  const goToSibling = useCallback(
    (delta: number) => {
      const next = siblings[siblingIndex + delta];
      // replace(), not push() — stepping through 20 posts shouldn't build a 20-deep
      // back stack that the user then has to unwind.
      if (next)
        router.replace({
          pathname: '/post/[id]',
          params: { id: next, nav: delta < 0 ? 'back' : 'fwd' },
        });
    },
    [siblings, siblingIndex, router],
  );

  // #26: swipe right-to-left → next post. JS-thread pan (house rule);
  // horizontal-only activation so the vertical scroll and the carousel keep working.
  // (The gesture itself is built below, after setDirection exists — #64 made a
  // rightward fling on someone else's post a like.)
  const canBrowse = siblings.length > 1 && siblingIndex >= 0;

  // Carousel wins until its end: the inner pager owns horizontal drags over the media,
  // but overscrolling past the last page (or before the first) hands off to the next /
  // previous post. The ref stops one iOS bounce firing it several times.
  const handedOff = useRef(false);
  const onCarouselScroll = useCallback(
    (x: number, pages: number) => {
      setPage(Math.max(0, Math.min(pages - 1, Math.round(x / pageW))));
      if (!canBrowse || handedOff.current) return;
      if (x > pageW * (pages - 1) + 48) {
        handedOff.current = true;
        goToSibling(1);
      } else if (x < -48) {
        handedOff.current = true;
        goToSibling(-1);
      }
    },
    [canBrowse, pageW, goToSibling],
  );

  const load = useCallback(async () => {
    if (!id) return;
    // Swiping between posts replaces the route param on the SAME screen instance, so
    // per-post state must reset by hand or it leaks into the next post.
    handedOff.current = false;
    setPage(0);
    setExtras([]);
    setStatus('loading');
    try {
      const data = await getPostDetail(id);
      if (!data) {
        setStatus('missing'); // RLS hides posts you can't see
        return;
      }
      setPost(data);
      setCommentCount(data.comment_count);
      setMyDir(data.my_direction);
      setLikeCount(data.like_count);
      setSkipCount(data.skip_count);
      setStatus('ready');
      getBookmarkState(id)
        .then((s) => setSaved(s.saved))
        .catch(() => {});
      getPostExtras(id)
        .then(setExtras)
        .catch(() => setExtras([]));
      // A couple of comments inline, so you can see whether there's any conversation
      // without opening the sheet to find out (#6).
      fetchComments(id, undefined, COMMENT_PREVIEW)
        .then(setPreview)
        .catch(() => setPreview([]));
    } catch {
      setStatus('error');
    }
  }, [id]);

  const setDirection = useCallback(
    async (target: 'left' | 'right' | null) => {
      if (!id) return;
      const cur = myDir;
      if (cur === target) return;
      // Optimistic: adjust the toggle + counts, revert on failure.
      const adjust = (sign: number, d: 'left' | 'right' | null) => {
        if (d === 'right') setLikeCount((n) => Math.max(0, n + sign));
        if (d === 'left') setSkipCount((n) => Math.max(0, n + sign));
      };
      setMyDir(target);
      adjust(-1, cur);
      adjust(+1, target);
      try {
        if (cur) await undoSwipe(id);
        if (target) await recordSwipe(id, target);
      } catch {
        setMyDir(cur);
        adjust(+1, cur);
        adjust(-1, target);
      }
    },
    [id, myDir],
  );

  // #68: the brief heart pop; fires on double-tap and on a like-fling.
  const [burst, setBurst] = useState(0);
  const likeWithBurst = useCallback(() => {
    if (myDir !== 'right') void setDirection('right');
    setBurst((n) => n + 1);
  }, [myDir, setDirection]);

  // #26/#64: one pan for both worlds. Leftward fling → next post. Rightward fling:
  // your own post pages back; on someone else's it pages back only when the swipe
  // STARTS in the left third of the screen — from mid-screen outward it is a like,
  // mirroring the deck. Double-tap likes too (never unlikes), Instagram-style.
  const browsePan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetX([-24, 24])
        .failOffsetY([-12, 12])
        .onEnd((e) => {
          // Where the finger went DOWN, recovered from the end event so no ref
          // is read inside this render-time memo.
          const startX = e.x - e.translationX;
          if (e.translationX < -60) {
            if (canBrowse) goToSibling(1);
          } else if (e.translationX > 60) {
            if (isOwner || startX < pageW * 0.35) {
              if (canBrowse) goToSibling(-1);
            } else {
              likeWithBurst();
            }
          }
        }),
    [canBrowse, goToSibling, isOwner, pageW, likeWithBurst],
  );
  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(260)
        .runOnJS(true)
        .onEnd(() => {
          if (!isOwner) likeWithBurst();
        }),
    [isOwner, likeWithBurst],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader; sets loading/error state internally
    void load();
  }, [load]);

  // Part 12C/12D: pin state + collaborators.
  const [pinned, setPinned] = useState(false);
  const [collabs, setCollabs] = useState<Collaborator[]>([]);
  const myCollab = collabs.find((c) => c.user_id === user?.id);
  const loadCollabs = useCallback(() => {
    if (!id) return;
    getCollaborators(id)
      .then(setCollabs)
      .catch(() => {});
  }, [id]);
  useEffect(() => {
    loadCollabs();
  }, [loadCollabs]);

  // ASA disclosure (brief 9A): the paid-partnership label on the post page.
  const [partnerLabel, setPartnerLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    void getPartnershipLabels([id])
      .then((m) => alive && setPartnerLabel(m.get(id) ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  const doReport = (reason: string) => {
    if (!post) return;
    reportPost(post.id, reason)
      .then(() => confirmReported(reason, { kind: 'post', id: post.id }))
      .catch(() => Alert.alert("Couldn't report", 'Please try again in a moment.'));
  };

  // The replace animation is chosen when the incoming screen first mounts (its loading
  // state), so every Stack.Screen in this file must carry it, not just the ready one.
  const animationTypeForReplace: 'push' | 'pop' = nav === 'back' ? 'pop' : 'push';

  if (status === 'loading')
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Post', animationTypeForReplace }} />
        <ActivityIndicator color={theme.textSecondary} />
      </ThemedView>
    );
  if (status !== 'ready' || !post) {
    return (
      <ThemedView style={styles.center}>
        <Stack.Screen options={{ headerShown: true, title: 'Post', animationTypeForReplace }} />
        <ThemedText type="small" themeColor="textSecondary">
          {status === 'missing' ? 'This post isn’t available.' : 'Couldn’t load this post.'}
        </ThemedText>
        <Button title="Go back" variant="secondary" onPress={() => router.back()} />
      </ThemedView>
    );
  }

  // Your own post: counts stay visible, but liking or skipping it is not a thing you
  // get to do to yourself (#17). Also enforced in RLS — see the swipes insert policy.
  const isOwnPost = post.user_id === user?.id;

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen
        options={{
          headerShown: true,
          animationTypeForReplace,
          // A plain `title` string isn't tappable, so "@handle" looked like a dead link
          // to anyone trying to reach the author's profile from a post (#7).
          headerTitle: () => (
            <Pressable
              onPress={() =>
                router.push({ pathname: '/u/[handle]', params: { handle: post.handle } })
              }
              hitSlop={8}
              accessibilityRole="link"
              accessibilityLabel={`Open @${post.handle}’s profile`}>
              <ThemedText type="smallBold" style={{ fontSize: 17 }} numberOfLines={1}>@{post.handle}</ThemedText>
            </Pressable>
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              <Pressable
                onPress={() => setSaveOpen(true)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={saved ? 'Saved — edit collection' : 'Save this post'}>
                <Ionicons
                  name={saved ? 'bookmark' : 'bookmark-outline'}
                  size={20}
                  color={saved ? theme.tint : theme.text}
                />
              </Pressable>
              <Pressable
                onPress={() => setReportOpen(true)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Report this post">
                <Ionicons name="flag-outline" size={20} color={theme.text} />
              </Pressable>
            </View>
          ),
        }}
      />
      <GestureDetector gesture={browsePan}>
        <ScrollView contentContainerStyle={styles.content}>
          <GestureDetector gesture={doubleTap}>
          <View>
            {post.sensitive && !revealed ? (
              <SensitiveCover onReveal={() => setRevealed(true)} />
            ) : null}
            {extras.length === 0 ? (
              post.media_type === 'video' ? (
                <PostVideo uri={post.media_url} overlays={post.overlays} />
              ) : (
                <Image
                  source={{ uri: post.media_url }}
                  style={[styles.media, aspect ? { aspectRatio: aspect } : null]}
                  contentFit="cover"
                  onLoad={(e) => setAspect(clampAspect(e.source.width, e.source.height))}
                />
              )
            ) : (
              // Carousel: cover + extras in a horizontal pager with dots + counter.
              <View>
                <ScrollView
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  onScroll={(e) =>
                    onCarouselScroll(e.nativeEvent.contentOffset.x, extras.length + 1)
                  }
                  scrollEventThrottle={16}
                  style={{ width: pageW, borderRadius: 16 }}>
                  {[{ media_url: post.media_url, media_type: post.media_type }, ...extras].map(
                    (m, i) => (
                      <View key={i} style={{ width: pageW }}>
                        {m.media_type === 'video' ? (
                          <PostVideo uri={m.media_url} />
                        ) : (
                          <Image
                            source={{ uri: m.media_url }}
                            style={[styles.media, aspect ? { aspectRatio: aspect } : null]}
                            contentFit="cover"
                            onLoad={
                              i === 0
                                ? (e) => setAspect(clampAspect(e.source.width, e.source.height))
                                : undefined
                            }
                          />
                        )}
                      </View>
                    ),
                  )}
                </ScrollView>
                <View style={styles.pagePill}>
                  <ThemedText type="small" style={{ color: '#fff' }}>
                    {page + 1}/{extras.length + 1}
                  </ThemedText>
                </View>
                <View style={styles.dots}>
                  {Array.from({ length: extras.length + 1 }).map((_, i) => (
                    <View
                      key={i}
                      style={[
                        styles.dot,
                        { backgroundColor: i === page ? theme.tint : theme.backgroundSelected },
                      ]}
                    />
                  ))}
                </View>
              </View>
            )}
            <HeartBurst trigger={burst} />
          </View>
          </GestureDetector>

          {/* Tap the heart to like/unlike, the cross to skip/un-skip. */}
          <View style={styles.stats}>
            <Stat
              icon={myDir === 'right' ? 'heart' : 'heart-outline'}
              value={likeCount}
              tint={myDir === 'right' ? BRAND.accent : theme.text}
              onPress={
                isOwnPost ? undefined : () => setDirection(myDir === 'right' ? null : 'right')
              }
            />
            <Stat
              icon={myDir === 'left' ? 'close-circle' : 'close'}
              value={skipCount}
              tint={myDir === 'left' ? BRAND.accent : theme.textSecondary}
              onPress={isOwnPost ? undefined : () => setDirection(myDir === 'left' ? null : 'left')}
            />
            <Stat
              icon="chatbubble-outline"
              value={commentCount}
              tint={theme.textSecondary}
              onPress={() => setCommentsOpen(true)}
            />
            <Pressable
              onPress={() => setShareOpen(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Share this post">
              <Ionicons name="share-outline" size={22} color={theme.textSecondary} />
            </Pressable>
            <View style={{ flex: 1 }} />
            {isOwnPost ? (
              <Pressable
                onPress={() => setOwnerMenu(true)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Edit or delete this post">
                <Ionicons name="create-outline" size={22} color={theme.text} />
              </Pressable>
            ) : null}
          </View>

          {captions ? (
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>
              <Ionicons
                name="text-outline"
                size={14}
                color={theme.textSecondary}
                style={{ marginTop: 2 }}
              />
              <ThemedText type="small" themeColor="textSecondary" style={{ flex: 1 }}>
                {captions}
              </ThemedText>
            </View>
          ) : null}
          {partnerLabel ? (
            <ThemedText type="smallBold" themeColor="textSecondary">
              {partnerLabel}
            </ThemedText>
          ) : null}
          {collabs.filter((c) => c.status === 'accepted').length > 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              with{' '}
              {collabs
                .filter((c) => c.status === 'accepted')
                .map((c) => `@${c.handle}`)
                .join(', ')}
              {myCollab?.status === 'accepted' ? '  ·  ' : ''}
              {myCollab?.status === 'accepted' ? (
                <ThemedText
                  type="small"
                  style={{ color: BRAND.accent }}
                  onPress={async () => {
                    if (
                      !(await confirm(
                        'Leave this collab?',
                        'The post stops showing on your profile.',
                        'Leave',
                      ))
                    )
                      return;
                    try {
                      await leaveCollab(post.id);
                      loadCollabs();
                    } catch {
                      /* noop */
                    }
                  }}>
                  Leave
                </ThemedText>
              ) : null}
            </ThemedText>
          ) : null}
          {myCollab?.status === 'pending' ? (
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <ThemedText type="small">Co-author invite:</ThemedText>
              <Button
                title="Accept"
                onPress={async () => {
                  try {
                    await respondCollab(post.id, true);
                    loadCollabs();
                  } catch {
                    /* noop */
                  }
                }}
              />
              <Button
                title="Decline"
                variant="secondary"
                onPress={async () => {
                  try {
                    await respondCollab(post.id, false);
                    loadCollabs();
                  } catch {
                    /* noop */
                  }
                }}
              />
            </View>
          ) : null}
          {post.caption ? (
            <MentionText type="default" style={styles.caption}>
              {post.caption}
            </MentionText>
          ) : null}

          {/* #61: the tagged place, finally visible. */}
          {post.location_label ? (
            <View style={styles.locationRow}>
              <Ionicons name="location-outline" size={14} color={theme.textSecondary} />
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {post.location_label}
              </ThemedText>
            </View>
          ) : null}

          {post.tags.length > 0 ? (
            <View style={styles.tagRow}>
              {post.tags.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => router.push({ pathname: '/tag/[name]', params: { name: t } })}
                  accessibilityRole="button"
                  accessibilityLabel={`See the ${t} tag`}
                  style={[styles.tag, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText type="small" style={{ color: theme.tint }}>
                    #{t}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          ) : null}

          {/* Own posts: analytics directly under caption/tags, above comments (#27).
            Part 12D: accepted co-authors share the full analytics too. */}
          {isOwnPost || myCollab?.status === 'accepted' ? (
            <>
              {/* Analytics and boosting are business tools. */}
              {isBusiness ? <PostAnalyticsCard postId={post.id} /> : null}
              {/* Likers list (Part 4B): only the owner has this door —
                co-authors get aggregates, never the named list. */}
              {isOwnPost ? (
                <Button
                  title="See who liked this"
                  variant="secondary"
                  onPress={() => router.push(`/post/${post.id}/likers`)}
                />
              ) : null}
              {/* Boost (Part 5B): public approved posts only; the server enforces.
                Owner only — co-authors can't spend on it. */}
              {isBusiness && isOwnPost && post.visibility === 'public' ? (
                <Button
                  title="Boost this post"
                  variant="secondary"
                  onPress={() => router.push(`/boost/${post.id}`)}
                />
              ) : null}
            </>
          ) : null}

          {preview.length > 0 ? (
            <View style={styles.previewWrap}>
              {preview.map((c) => (
                <Pressable
                  key={c.id}
                  onPress={() => setCommentsOpen(true)}
                  style={styles.previewRow}>
                  <ThemedText type="smallBold">@{c.author_handle}</ThemedText>
                  <MentionText type="small" style={styles.previewBody} numberOfLines={2}>
                    {c.is_deleted ? 'This comment was deleted.' : (c.body ?? '')}
                  </MentionText>
                </Pressable>
              ))}
            </View>
          ) : null}

          <Pressable
            onPress={() => setCommentsOpen(true)}
            accessibilityRole="button"
            style={[styles.commentsBtn, { borderColor: theme.border }]}>
            <Ionicons name="chatbubble-outline" size={18} color={theme.text} />
            {/* numberOfLines: the row once wrapped mid-word on narrow screens (#41). */}
            <ThemedText type="smallBold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {commentCount > 0
                ? `View ${commentCount} comment${commentCount === 1 ? '' : 's'}`
                : 'Add a comment'}
            </ThemedText>
          </Pressable>

          {/* Swipe left/right anywhere on the post to move between your own posts (#26);
            the counter is the only chrome left now the buttons are gone. */}
          {canBrowse ? (
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={{ textAlign: 'center', marginTop: 10 }}>
              {siblingIndex + 1} of {siblings.length} · swipe to browse
            </ThemedText>
          ) : null}
        </ScrollView>
      </GestureDetector>

      {commentsOpen ? (
        <CommentSheet
          postOwnerId={post.user_id}
          postId={post.id}
          onClose={() => {
            setCommentsOpen(false);
            // Otherwise a comment you just wrote wouldn't appear in the inline preview.
            if (id)
              fetchComments(id, undefined, COMMENT_PREVIEW)
                .then(setPreview)
                .catch(() => {});
          }}
          onCountDelta={(d) => setCommentCount((c) => Math.max(0, c + d))}
        />
      ) : null}

      <ActionMenu
        visible={reportOpen}
        title="Report this post"
        onClose={() => setReportOpen(false)}
        options={POST_REPORT_REASONS.map((r) => ({ label: r, onPress: () => doReport(r) }))}
      />

      <CollectionPicker
        postId={post.id}
        visible={saveOpen}
        onClose={() => setSaveOpen(false)}
        onChange={setSaved}
      />

      {/* Part 14E: audience rules — only PUBLIC posts may leave the app. */}
      {shareOpen ? (
        <ShareSheet
          post={{ id: post.id, caption: post.caption }}
          allowExternal={post.visibility === 'public'}
          onClose={() => setShareOpen(false)}
        />
      ) : null}

      <BottomSheet visible={captionsOpen} onClose={() => setCaptionsOpen(false)}>
        <ThemedText type="smallBold">Video captions</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Shown with your video for people watching without sound.
        </ThemedText>
        <TextField
          label=""
          placeholder="What's said or shown in the video"
          value={captionsDraft}
          onChangeText={setCaptionsDraft}
          multiline
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            title="Save"
            onPress={async () => {
              try {
                await setVideoCaptions(post.id, captionsDraft.trim() || null);
                setCaptions(captionsDraft.trim() || null);
                setCaptionsOpen(false);
              } catch (e) {
                Alert.alert("Couldn't save", e instanceof Error ? e.message : 'Try again.');
              }
            }}
          />
          <Button title="Cancel" variant="secondary" onPress={() => setCaptionsOpen(false)} />
        </View>
      </BottomSheet>

      <BottomSheet visible={collabInviteOpen} onClose={() => setCollabInviteOpen(false)}>
        <ThemedText type="smallBold">Invite a co-author</ThemedText>
        <TextField
          label=""
          placeholder="@handle"
          autoCapitalize="none"
          autoCorrect={false}
          value={collabHandle}
          onChangeText={setCollabHandle}
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            title="Invite"
            disabled={!collabHandle.trim()}
            onPress={async () => {
              try {
                await inviteCollaborator(post.id, collabHandle.trim());
                setCollabInviteOpen(false);
                setCollabHandle('');
                loadCollabs();
                Alert.alert('Invite sent', 'They appear as a co-author once they accept.');
              } catch (e) {
                Alert.alert("Couldn't invite", e instanceof Error ? e.message : 'Try again.');
              }
            }}
          />
          <Button title="Cancel" variant="secondary" onPress={() => setCollabInviteOpen(false)} />
        </View>
      </BottomSheet>

      <ActionMenu
        visible={ownerMenu}
        title="Your post"
        onClose={() => setOwnerMenu(false)}
        options={[
          {
            label: 'Edit post',
            onPress: () => router.push({ pathname: '/post/[id]/edit', params: { id: post.id } }),
          },
          {
            label: pinned ? 'Unpin from profile' : 'Pin to profile',
            onPress: async () => {
              try {
                await setPostPinned(post.id, !pinned);
                setPinned(!pinned);
              } catch (e) {
                Alert.alert("Couldn't pin", e instanceof Error ? e.message : 'Try again.');
              }
            },
          },
          ...(isBusiness
            ? [{ label: 'Invite co-author…', onPress: () => setCollabInviteOpen(true) }]
            : []),
          {
            label: 'Download post',
            onPress: async () => {
              try {
                await downloadOwnPostMedia(post.media_url, post.media_type);
              } catch {
                Alert.alert("Couldn't download", 'Please try again.');
              }
            },
          },
          ...(post.media_type === 'video'
            ? [
                {
                  label: captions ? 'Edit captions…' : 'Add captions…',
                  onPress: () => {
                    setCaptionsDraft(captions ?? '');
                    setCaptionsOpen(true);
                  },
                },
              ]
            : []),
          {
            label: 'Delete post',
            destructive: true,
            onPress: async () => {
              if (
                !(await confirm(
                  'Delete post?',
                  'This permanently removes it and its comments. This cannot be undone.',
                  'Delete',
                ))
              )
                return;
              try {
                await deletePost(post.id);
                router.back();
              } catch {
                Alert.alert('Could not delete', 'Please try again.');
              }
            },
          },
        ]}
      />
    </ThemedView>
  );
}

function Stat({
  icon,
  value,
  tint,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  value: number;
  tint: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      accessibilityRole="button"
      style={styles.stat}>
      <Ionicons name={icon} size={20} color={tint} />
      <ThemedText type="smallBold">{formatCount(value)}</ThemedText>
    </Pressable>
  );
}

function PostVideo({ uri, overlays }: { uri: string; overlays?: unknown }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = false;
    p.play();
  });
  const parsed = useMemo(() => parseVideoOverlays(overlays), [overlays]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  return (
    <View
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      <VideoView player={player} style={styles.media} contentFit="cover" />
      <VideoOverlays overlays={parsed} width={box.w} height={box.h} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  content: { padding: 16, gap: 14 },
  media: { width: '100%', aspectRatio: 4 / 5, borderRadius: 16, backgroundColor: '#000' },
  pagePill: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, marginTop: 8 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  stats: { flexDirection: 'row', gap: 20 },
  stat: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  caption: {},
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -8 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  previewWrap: { gap: 6, marginTop: 12 },
  previewRow: { flexDirection: 'row', gap: 6, alignItems: 'baseline' },
  previewBody: { flex: 1 },
  siblingNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: 14,
  },
  siblingBtn: { minWidth: 108 },
  commentsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
  },
});

const stylesCollab = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
});
