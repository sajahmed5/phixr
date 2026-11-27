/* eslint-disable react-hooks/immutability -- Reanimated shared values (incl. the shared
   `topProgress` passed to the card beneath) are intentionally mutated from worklets; the
   rule's "don't mutate props" heuristic doesn't model shared values. */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { SwipeCard } from '@/components/deck/swipe-card';
import { SwipeStamp } from '@/components/deck/swipe-stamp';
import type { DeckCard, SwipeDirection } from '@/lib/deck';

const VELOCITY_THRESHOLD = 800;
const PROGRESS_DISTANCE = 180; // px of drag that maps the beneath-card to full size
const FLY_MS = 200;
const HEART_HOLD_MS = 550; // how long the heart shows before the card flies off on a like

type SwipeDeckProps = {
  hasTabBar?: boolean;
  cards: DeckCard[];
  onSwipe: (direction: SwipeDirection) => void;
  onShare: (card: DeckCard) => void;
  onOpenComments: (card: DeckCard) => void;
  onOpenProfile: (handle: string) => void;
  onOpenTag: (tag: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  hideCounts?: boolean;
  /** Space an overlay bar takes at the top (Home's logo + search, #78). */
  topInset?: number;
  /** Full view (#79). Pinch-to-full-view is on only when the screen handles it. */
  fullView?: boolean;
  onFullViewChange?: (on: boolean) => void;
};

/**
 * Custom deck on Reanimated + Gesture Handler. The top card follows the finger with
 * rotation; releasing past a distance or velocity threshold commits (fly-off), otherwise
 * it springs back. Swipe up opens share and springs back (does not consume the card).
 * Double-tapping the card, or tapping the heart, likes it through the exact same commit
 * path as a swipe-right. All per-frame work is in worklets on the UI thread.
 */
export function SwipeDeck({
  hasTabBar = true,
  cards,
  onSwipe,
  onShare,
  onOpenComments,
  onOpenProfile,
  onOpenTag,
  canUndo,
  onUndo,
  hideCounts,
  topInset = 0,
  fullView = false,
  onFullViewChange,
}: SwipeDeckProps) {
  const { width, height } = useWindowDimensions();
  // Drag magnitude of the top card (0..1), read by the card beneath to scale up.
  const topProgress = useSharedValue(0);

  const visible = cards.slice(0, 2);
  const topId = visible[0]?.id;

  // #80: reset the beneath-card scale only AFTER the next card has become the top one.
  // Resetting it inside the swipe callback (as before) shrank the card that was about to
  // take over back to 94% for a frame or two before it re-rendered as the top card — part
  // of the "the photo refreshes when I swipe" jolt.
  useLayoutEffect(() => {
    topProgress.value = 0;
  }, [topId, topProgress]);

  // Leaving the card (any way) ends full view, so the next card opens normally.
  useEffect(() => {
    onFullViewChange?.(false);
  }, [topId, onFullViewChange]);

  return (
    <View style={styles.container}>
      {visible[1] ? (
        <DeckCardView
          key={visible[1].id}
          card={visible[1]}
          hasTabBar={hasTabBar}
          isTop={false}
          topProgress={topProgress}
          width={width}
          height={height}
          onSwipe={onSwipe}
          onShare={onShare}
          onOpenComments={onOpenComments}
          onOpenProfile={onOpenProfile}
          onOpenTag={onOpenTag}
          canUndo={canUndo}
          onUndo={onUndo}
          hideCounts={hideCounts}
          topInset={topInset}
          fullView={false}
        />
      ) : null}
      {visible[0] ? (
        <DeckCardView
          key={visible[0].id}
          card={visible[0]}
          hasTabBar={hasTabBar}
          isTop
          topProgress={topProgress}
          width={width}
          height={height}
          onSwipe={onSwipe}
          onShare={onShare}
          onOpenComments={onOpenComments}
          onOpenProfile={onOpenProfile}
          onOpenTag={onOpenTag}
          canUndo={canUndo}
          onUndo={onUndo}
          hideCounts={hideCounts}
          topInset={topInset}
          fullView={fullView}
          onFullViewChange={onFullViewChange}
        />
      ) : null}
    </View>
  );
}

type DeckCardViewProps = {
  hasTabBar: boolean;
  card: DeckCard;
  isTop: boolean;
  topProgress: SharedValue<number>;
  width: number;
  height: number;
  onSwipe: (direction: SwipeDirection) => void;
  onShare: (card: DeckCard) => void;
  onOpenComments: (card: DeckCard) => void;
  onOpenProfile: (handle: string) => void;
  onOpenTag: (tag: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  hideCounts?: boolean;
  topInset: number;
  fullView: boolean;
  onFullViewChange?: (on: boolean) => void;
};

function DeckCardView({
  card,
  hasTabBar,
  isTop,
  topProgress,
  width,
  height,
  onSwipe,
  onShare,
  onOpenComments,
  onOpenProfile,
  onOpenTag,
  canUndo,
  onUndo,
  hideCounts,
  topInset,
  fullView,
  onFullViewChange,
}: DeckCardViewProps) {
  // Carousel page for this card. Per-card state, so it resets naturally when the card
  // is swiped away and a new one takes its place.
  const [page, setPage] = useState(0);
  const shotCount = card.carousel?.length ?? 1;
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  // Single-commit latch: once a card is committed (by swipe, double-tap, or a tap button)
  // any further commit is ignored — this is what prevents a double-award when the user
  // double-taps AND swipes the same card. Lives on the UI thread; read from both worklets
  // (pan) and JS (tap handlers).
  const committed = useSharedValue(false);
  // Heart-pop overlay shown on a like, before the card leaves.
  const heartScale = useSharedValue(0);
  const heartOpacity = useSharedValue(0);

  // #79 full view. Paid/partner posts keep their disclosure on screen, so no full view.
  const canFullView = isTop && !!onFullViewChange && !card.is_ad && !card.partner_label;
  const enterFullView = useCallback(() => onFullViewChange?.(true), [onFullViewChange]);
  const exitFullView = useCallback(() => onFullViewChange?.(false), [onFullViewChange]);
  // Mirrors of JS state the UI-thread gesture callbacks need.
  const fullViewSV = useSharedValue(fullView);
  useEffect(() => {
    fullViewSV.value = fullView;
  }, [fullView, fullViewSV]);
  const pinchScale = useSharedValue(1);
  const pinching = useSharedValue(false);
  // A drag that began in full view only exits it; it never moves or commits the card.
  const dragExitsFullView = useSharedValue(false);

  const commitX = width * 0.28;
  const commitY = height * 0.16;

  // Fly the card off to `direction` and advance once. Shared by the pan release and the
  // tap/double-tap like path so points/undo/advance are identical to a real swipe.
  const flyOut = useCallback(
    (direction: SwipeDirection, delayMs = 0) => {
      const sign = direction === 'right' ? 1 : -1;
      y.value = withDelay(delayMs, withTiming(y.value + 40, { duration: FLY_MS }));
      x.value = withDelay(
        delayMs,
        withTiming(sign * 1.6 * width, { duration: FLY_MS }, (finished) => {
          if (finished) runOnJS(onSwipe)(direction);
        }),
      );
    },
    [onSwipe, width, x, y],
  );

  // Like via double-tap or the heart button. Plays the heart, then flies off right.
  const like = useCallback(() => {
    if (committed.value) return;
    committed.value = true;
    heartScale.value = 0.5;
    heartOpacity.value = 0;
    heartOpacity.value = withSequence(
      withTiming(1, { duration: 110 }),
      withDelay(HEART_HOLD_MS - 110, withTiming(0, { duration: 160 })),
    );
    heartScale.value = withSequence(withSpring(1, { damping: 9 }), withTiming(1.25, { duration: 220 }));
    flyOut('right', HEART_HOLD_MS);
  }, [committed, flyOut, heartOpacity, heartScale]);

  // Skip via the cross button — same commit path as a swipe-left (no heart).
  const skip = useCallback(() => {
    if (committed.value) return;
    committed.value = true;
    flyOut('left', 0);
  }, [committed, flyOut]);

  const pan = Gesture.Pan()
    .enabled(isTop)
    // One finger only: two fingers are a pinch, and must never drag the card away.
    .maxPointers(1)
    .activeOffsetX([-12, 12])
    .activeOffsetY([-12, 12])
    .onStart(() => {
      dragExitsFullView.value = fullViewSV.value;
      if (fullViewSV.value) runOnJS(exitFullView)();
    })
    .onUpdate((e) => {
      if (committed.value || dragExitsFullView.value || pinching.value) return;
      x.value = e.translationX;
      y.value = e.translationY;
      topProgress.value = Math.min(
        1,
        (Math.abs(e.translationX) + Math.abs(e.translationY)) / PROGRESS_DISTANCE,
      );
    })
    .onEnd((e) => {
      if (committed.value) return;
      if (dragExitsFullView.value || pinching.value) {
        x.value = withSpring(0);
        y.value = withSpring(0);
        topProgress.value = withSpring(0);
        return;
      }
      const up =
        (e.translationY < -commitY || e.velocityY < -VELOCITY_THRESHOLD) &&
        Math.abs(e.translationY) > Math.abs(e.translationX);
      const right = e.translationX > commitX || e.velocityX > VELOCITY_THRESHOLD;
      const left = e.translationX < -commitX || e.velocityX < -VELOCITY_THRESHOLD;

      if (up) {
        // Share: bounce back, don't consume the card.
        x.value = withSpring(0);
        y.value = withSpring(0);
        topProgress.value = withSpring(0);
        runOnJS(onShare)(card);
      } else if (right || left) {
        committed.value = true;
        const direction: SwipeDirection = right ? 'right' : 'left';
        y.value = withTiming(e.translationY + 40, { duration: FLY_MS });
        x.value = withTiming((right ? 1.5 : -1.5) * width, { duration: FLY_MS }, (finished) => {
          if (finished) runOnJS(onSwipe)(direction);
        });
      } else {
        x.value = withSpring(0);
        y.value = withSpring(0);
        topProgress.value = withSpring(0);
      }
    });

  // numberOfTaps(2) IS the single-vs-double relationship — a single tap can never satisfy
  // it, so no timing hack is needed to keep single taps from liking. Runs on the JS thread
  // so it can call `like` directly. Simultaneous with the pan: a double-tap is stationary
  // so the pan (which needs 12px of movement) never activates, and vice-versa.
  const doubleTap = Gesture.Tap()
    .enabled(isTop && !fullView)
    .numberOfTaps(2)
    .maxDuration(260)
    .runOnJS(true)
    .onEnd(like);

  // Single tap pages through a carousel (wrapping at the end). Exclusive() lets the
  // double-tap win first, so tap-to-advance never steals a like; a single tap simply
  // resolves once the double-tap window lapses. Left/right swipe still acts on the
  // whole post, so a carousel is liked/skipped as one thing.
  // In full view a single tap brings the info back instead (#79).
  const singleTap = Gesture.Tap()
    .enabled(isTop && (shotCount > 1 || fullView))
    .numberOfTaps(1)
    .runOnJS(true)
    .onEnd(() => {
      if (fullView) exitFullView();
      else setPage((p) => (p + 1) % shotCount);
    });

  // #79: pinch zooms the photo with the fingers; letting go past a small zoom opens the
  // full view (whole uncropped photo, overlays hidden). The zoom always eases back.
  const pinch = Gesture.Pinch()
    .enabled(canFullView && !fullView)
    .onStart(() => {
      pinching.value = true;
      x.value = withSpring(0);
      y.value = withSpring(0);
    })
    .onUpdate((e) => {
      pinchScale.value = Math.min(4, Math.max(1, e.scale));
    })
    .onEnd(() => {
      const open = pinchScale.value > 1.15;
      pinchScale.value = withTiming(1, { duration: 180 });
      if (open) runOnJS(enterFullView)();
    })
    .onFinalize(() => {
      pinching.value = false;
    });

  const gesture = Gesture.Simultaneous(pan, pinch, Gesture.Exclusive(doubleTap, singleTap));

  const mediaStyle = useAnimatedStyle(() => ({ transform: [{ scale: pinchScale.value }] }));

  const cardStyle = useAnimatedStyle(() => {
    if (isTop) {
      const rotate = interpolate(x.value, [-width, 0, width], [-10, 0, 10], Extrapolation.CLAMP);
      return {
        transform: [{ translateX: x.value }, { translateY: y.value }, { rotate: `${rotate}deg` }],
      };
    }
    const scale = interpolate(topProgress.value, [0, 1], [0.94, 1], Extrapolation.CLAMP);
    const translateY = interpolate(topProgress.value, [0, 1], [14, 0], Extrapolation.CLAMP);
    return { transform: [{ scale }, { translateY }] };
  }, [isTop, width]);

  const likeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [0, commitX], [0, 1], Extrapolation.CLAMP),
  }));
  const skipStyle = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [-commitX, 0], [1, 0], Extrapolation.CLAMP),
  }));
  const shareStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [-commitY, 0], [1, 0], Extrapolation.CLAMP),
  }));
  const heartStyle = useAnimatedStyle(() => ({
    opacity: heartOpacity.value,
    transform: [{ scale: heartScale.value }],
  }));

  const content = (
    <Animated.View style={[styles.cardWrap, cardStyle]}>
      <SwipeCard
        hasTabBar={hasTabBar}
        card={card}
        isActive={isTop}
        page={page}
        onOpenComments={isTop ? () => onOpenComments(card) : undefined}
        onLike={isTop ? like : undefined}
        onSkip={isTop ? skip : undefined}
        onOpenProfile={isTop ? onOpenProfile : undefined}
        onOpenTag={isTop ? onOpenTag : undefined}
        canUndo={isTop ? canUndo : undefined}
        onUndo={isTop ? onUndo : undefined}
        hideCounts={hideCounts}
        topInset={topInset}
        fullView={fullView}
        mediaStyle={mediaStyle}
      />
      {isTop ? (
        <>
          <Animated.View style={[styles.stamp, styles.stampLeft, { top: 40 + topInset }, likeStyle]}>
            <SwipeStamp label="LIKE" color="#2E7D46" />
          </Animated.View>
          <Animated.View style={[styles.stamp, styles.stampRight, { top: 40 + topInset }, skipStyle]}>
            <SwipeStamp label="SKIP" color="#D64545" />
          </Animated.View>
          <Animated.View style={[styles.stamp, styles.stampTop, { top: 80 + topInset }, shareStyle]}>
            <SwipeStamp label="SHARE" color="#208AEF" />
          </Animated.View>
          <Animated.View style={styles.heart} pointerEvents="none">
            <Animated.View style={heartStyle}>
              <Ionicons name="heart" size={128} color="#fff" style={styles.heartIcon} />
            </Animated.View>
          </Animated.View>
        </>
      ) : null}
    </Animated.View>
  );

  // #80: ALWAYS wrap in the detector (its gestures are disabled on the beneath card).
  // Wrapping only the top card changed the element tree when the beneath card took over,
  // so React threw its whole subtree away and rebuilt it: the photo faded in again and
  // the bottom scrim vanished for a frame — the "refresh" seen on every swipe.
  return <GestureDetector gesture={gesture}>{content}</GestureDetector>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  cardWrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  stamp: { position: 'absolute', top: 40, pointerEvents: 'none' },
  stampLeft: { left: 24, transform: [{ rotate: '-14deg' }] },
  stampRight: { right: 24, transform: [{ rotate: '14deg' }] },
  stampTop: { alignSelf: 'center', top: 80 },
  heart: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heartIcon: {
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 2 },
  },
});
