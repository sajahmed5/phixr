import { Ionicons } from '@expo/vector-icons';
import { Canvas, LinearGradient, Rect, vec } from '@shopify/react-native-skia';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { memo, useState } from 'react';
import { Platform, Pressable, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CardMedia } from '@/components/deck/card-media';
import { SensitiveCover } from '@/components/sensitive-cover';
import { AdOverlay } from '@/components/deck/ad-overlay';
import { TAB_BAR_CLEARANCE } from '@/constants/config';
import type { DeckCard } from '@/lib/deck';
import { formatCount } from '@/lib/format';
import { isOpenablePlace, placeHref } from '@/lib/places';
import { formatRelative } from '@/lib/relative-time';

/**
 * Presentational card: full-bleed media + overlays. Used for both the interactive top
 * card and the card beneath, so it stays free of gesture/animation concerns. All tap
 * targets are wired only when `isActive` (the top card) — the beneath-card is inert.
 */
export const SwipeCard = memo(function SwipeCard({
  card,
  isActive,
  page = 0,
  onOpenComments,
  onLike,
  onSkip,
  onOpenProfile,
  hasTabBar = true,
  onOpenTag,
  canUndo,
  onUndo,
  hideCounts,
  topInset = 0,
  fullView = false,
  mediaStyle,
}: {
  card: DeckCard;
  isActive: boolean;
  /** Current carousel page (index into card.carousel). Ignored for single-media posts. */
  page?: number;
  onOpenComments?: () => void;
  onLike?: () => void;
  onSkip?: () => void;
  onOpenProfile?: (handle: string) => void;
  /** #32: the seeded /deck route has no floating tab bar — reserving clearance for one
   *  stranded the caption block mid-screen there. */
  hasTabBar?: boolean;
  onOpenTag?: (tag: string) => void;
  canUndo?: boolean;
  onUndo?: () => void;
  /** Part 14D: viewer hides like counts on other people's posts. */
  hideCounts?: boolean;
  /** Space taken at the top by an overlay bar (Home's full-screen logo + search, #78),
   *  so the rail and carousel counter start below it. */
  topInset?: number;
  /** Full view (#79): the whole uncropped photo on black, every overlay hidden. */
  fullView?: boolean;
  /** Pinch-zoom transform for the media only (#79), driven by the deck's gesture. */
  mediaStyle?: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
}) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const tagFit = fitTags(card.tags, width - 36);
  const [scrimBox, setScrimBox] = useState({ w: 0, h: 0 });
  // Sensitive cover (6B): covered until the viewer taps. Server never sends
  // sensitive cards to minors, so reaching here means an adult viewer.
  const [revealed, setRevealed] = useState(false);
  // Carousel: swap in the current page's media. Left/right swipe still acts on the whole
  // post (skip/like) — a single tap advances (wired in the deck's gesture composition).
  const shots = card.carousel;
  const current = shots?.[Math.min(page, shots.length - 1)];
  const shown = current ? { ...card, media_url: current.media_url, media_type: current.media_type } : card;
  return (
    <View style={[styles.card, fullView && styles.cardFull]}>
      <Animated.View style={[StyleSheet.absoluteFill, mediaStyle]}>
        <CardMedia card={shown} isActive={isActive} fit={fullView ? 'contain' : 'cover'} />
      </Animated.View>
      {card.sensitive && !revealed ? <SensitiveCover onReveal={() => setRevealed(true)} /> : null}
      {card.is_ad ? <AdOverlay card={card} isActive={isActive} /> : null}

      {fullView ? null : (
      <>
      {/* Position counter — static, so it never competes with tap-to-advance. */}
      {shots ? (
        <View style={[styles.carousel, { top: 16 + topInset }]} pointerEvents="none">
          <Ionicons name="copy" size={13} color="#fff" />
          <ThemedText type="small" style={styles.carouselText}>
            {Math.min(page, shots.length - 1) + 1}/{shots.length}
          </ThemedText>
        </View>
      ) : null}

      {/* Top-right: like / skip / comment. Tapping the heart likes, the cross skips —
          same commit path as a swipe (handled by the parent via onLike/onSkip). */}
      <View style={[styles.topRight, { top: 16 + topInset }]}>
        <ActionStat
          icon="heart"
          value={hideCounts ? null : card.like_count}
          onPress={onLike}
          label="Like this post"
        />
        <ActionStat
          icon="close"
          value={card.skip_count}
          onPress={onSkip}
          label="Skip this post"
        />
        <Pressable
          onPress={onOpenComments}
          disabled={!onOpenComments}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open comments"
          style={({ pressed }) => [styles.commentButton, pressed && { opacity: 0.6 }]}>
          <Ionicons name="chatbubble" size={RAIL_ICON} color={RAIL_TINT} style={styles.railIcon} />
          <ThemedText type="small" style={styles.statText}>
            {formatCount(card.comment_count)}
          </ThemedText>
        </Pressable>
        {onUndo ? (
          <Pressable
            onPress={onUndo}
            disabled={!canUndo}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Undo last swipe"
            accessibilityState={{ disabled: !canUndo }}
            style={({ pressed }) => [
              styles.actionButton,
              { opacity: canUndo ? (pressed ? 0.6 : 1) : 0.35 },
            ]}>
            <Ionicons name="arrow-undo" size={RAIL_ICON} color={RAIL_TINT} style={styles.railIcon} />
          </Pressable>
        ) : null}
      </View>

      {/* Bottom scrim + poster identity + caption + tags. `box-none` so the scrim area
          itself passes touches through to the media (double-tap to like), while its
          interactive children (avatar, handle, tags) still receive their taps. */}
      <View
        style={[styles.bottomScrim, { paddingBottom: hasTabBar ? TAB_BAR_CLEARANCE : insets.bottom + 10 }]}
        pointerEvents="box-none"
        onLayout={(e) => setScrimBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {/* Slim, soft fade instead of the old solid band (#23): a Skia gradient (no new
            native module) that only darkens the strip behind the text lines, so the
            media loses far less to the overlay. */}
        <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
          <Rect x={0} y={0} width={scrimBox.w} height={scrimBox.h}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, scrimBox.h)}
              colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.45)', 'rgba(0,0,0,0.78)']}
              positions={[0, 0.35, 1]}
            />
          </Rect>
        </Canvas>
        {shots ? (
          <View style={styles.dots} pointerEvents="none">
            {shots.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.dot,
                  i === Math.min(page, shots.length - 1)
                    ? styles.dotOn
                    : styles.dotOff,
                ]}
              />
            ))}
          </View>
        ) : null}
        {/* Paid placement is ALWAYS labelled (brief 5B). */}
        {card.is_boosted ? (
          <View style={styles.boostedChip} pointerEvents="none">
            <Ionicons name="trending-up" size={12} color="#fff" />
            <ThemedText type="small" style={styles.boostedText}>
              Boosted
            </ThemedText>
          </View>
        ) : null}
        {/* ASA disclosure (brief 9A): obvious, and the creator can't remove it. */}
        {card.partner_label ? (
          <View style={styles.boostedChip} pointerEvents="none">
            <Ionicons name="briefcase-outline" size={12} color="#fff" />
            <ThemedText type="small" style={styles.boostedText}>
              {card.partner_label}
            </ThemedText>
          </View>
        ) : null}
        <Pressable
          onPress={isActive && onOpenProfile ? () => onOpenProfile(card.poster_handle) : undefined}
          disabled={!isActive || !onOpenProfile}
          accessibilityRole="button"
          accessibilityLabel={`Open @${card.poster_handle}'s profile`}
          style={({ pressed }) => [styles.posterRow, pressed && { opacity: 0.7 }]}>
          {card.poster_avatar_url ? (
            <Image
              source={{ uri: card.poster_avatar_url }}
              style={styles.avatar}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <ThemedText type="small" style={styles.avatarInitial}>
                {card.poster_display_name.slice(0, 1).toUpperCase()}
              </ThemedText>
            </View>
          )}
          <View style={styles.posterText}>
            <ThemedText type="smallBold" style={styles.onMedia} numberOfLines={1}>
              {card.poster_display_name}
            </ThemedText>
            <ThemedText type="small" style={styles.onMediaDim} numberOfLines={1}>
              @{card.poster_handle}
            </ThemedText>
          </View>
        </Pressable>

        {/* Where + when, under the poster (27 Nov). Tappable on the top card only,
            like the tags; opens the place page. */}
        <Pressable
          onPress={
            isActive && card.place && isOpenablePlace(card.place)
              ? () => router.push(placeHref(card.place!))
              : undefined
          }
          disabled={!isActive || !card.place || !isOpenablePlace(card.place)}
          hitSlop={6}
          accessibilityRole={card.place ? 'link' : undefined}
          accessibilityLabel={card.place ? `Open ${card.place.label}` : undefined}
          style={({ pressed }) => [styles.placePill, pressed && { opacity: 0.7 }]}>
          {card.place ? (
            <>
              <Ionicons name={card.place.isBusiness ? 'storefront' : 'location'} size={12} color="#fff" />
              <ThemedText type="smallBold" style={styles.onMedia} numberOfLines={1}>
                {card.place.label}
              </ThemedText>
              <ThemedText type="small" style={styles.onMediaDim}>
                · {formatRelative(card.created_at)}
              </ThemedText>
            </>
          ) : (
            <ThemedText type="small" style={styles.onMediaDim}>
              {formatRelative(card.created_at)}
            </ThemedText>
          )}
        </Pressable>

        {card.caption ? (
          <ThemedText type="default" style={styles.onMedia} numberOfLines={2}>
            {card.caption}
          </ThemedText>
        ) : null}

        {card.tags.length > 0 ? (
          <View style={styles.tagRow} pointerEvents="box-none">
            {tagFit.shown.map((t) => (
              <Pressable
                key={t}
                onPress={isActive && onOpenTag ? () => onOpenTag(t) : undefined}
                disabled={!isActive || !onOpenTag}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Search the ${t} tag`}
                style={({ pressed }) => pressed && { opacity: 0.6 }}>
                <ThemedText type="small" style={styles.tag}>
                  #{t}
                </ThemedText>
              </Pressable>
            ))}
            {tagFit.hidden > 0 ? (
              <ThemedText type="small" style={styles.tagMore}>
                +{tagFit.hidden}
              </ThemedText>
            ) : null}
          </View>
        ) : null}
      </View>
      </>
      )}
    </View>
  );
});

/** Rail icons (like / skip / comment / undo) and Home's search share one size and colour
 *  (#78): white with a drop shadow, so they read on any photo. */
export const RAIL_ICON = 22;
export const RAIL_TINT = '#FFFFFF';

/**
 * #77: tags stay on ONE line — as many as fit, then "+N". An estimate (no measuring pass,
 * so no flicker): ~7pt per character at the small size, plus the 10pt gap.
 */
function fitTags(tags: string[], width: number): { shown: string[]; hidden: number } {
  const CHAR = 7;
  const GAP = 10;
  const MORE = 3 * CHAR + GAP;
  const shown: string[] = [];
  let used = 0;
  for (let i = 0; i < tags.length; i++) {
    const cost = (tags[i].length + 1) * CHAR + (shown.length ? GAP : 0);
    const reserve = i < tags.length - 1 ? MORE : 0;
    if (used + cost + reserve > width && shown.length > 0) break;
    shown.push(tags[i]);
    used += cost;
  }
  return { shown, hidden: tags.length - shown.length };
}

function ActionStat({
  icon,
  value,
  onPress,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  /** null/undefined = count hidden (poster or viewer choice, Part 14D). */
  value: number | null | undefined;
  onPress?: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.stat, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={RAIL_ICON} color={RAIL_TINT} style={styles.railIcon} />
      {value == null ? null : (
        <ThemedText type="small" style={styles.statText}>
          {formatCount(value)}
        </ThemedText>
      )}
    </Pressable>
  );
}

// Cross-platform text shadow for legibility over media (web wants the shorthand).
const textShadow = Platform.select({
  web: { textShadow: '0px 1px 3px rgba(0,0,0,0.6)' },
  default: {
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
}) as object;

const styles = StyleSheet.create({
  card: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  cardFull: { backgroundColor: '#000' },
  topRight: {
    position: 'absolute',
    top: 16,
    right: 12,
    gap: 14,
    alignItems: 'center',
  },
  carousel: {
    position: 'absolute',
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  carouselText: { color: '#fff', fontWeight: '600' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingBottom: 10 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { backgroundColor: '#fff' },
  dotOff: { backgroundColor: 'rgba(255,255,255,0.4)' },
  stat: { alignItems: 'center', gap: 2 },
  commentButton: { alignItems: 'center', gap: 2, marginTop: 4 },
  actionButton: { alignItems: 'center', marginTop: 4 },
  // Orange rail icons keep a drop shadow so they read on any photo behind them.
  railIcon: { ...textShadow },
  statText: { color: '#fff', fontWeight: '700', ...textShadow },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 18,
    paddingTop: 40,
    gap: 8,
  },
  posterRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  boostedChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 6,
  },
  boostedText: { color: '#fff' },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)' },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { color: '#fff', fontWeight: '700' },
  posterText: { flex: 1 },
  onMedia: { color: '#fff', ...textShadow },
  onMediaDim: { color: 'rgba(255,255,255,0.85)' },
  tagRow: { flexDirection: 'row', flexWrap: 'nowrap', columnGap: 10, overflow: 'hidden' },
  tagMore: { color: 'rgba(255,255,255,0.85)', ...textShadow },
  placePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  tag: { color: '#FF9D2E', ...textShadow },
});
