/* eslint-disable react-hooks/immutability -- expo-video's player is a mutable controller
   object by design (player.muted / play() / currentTime); the rule's "don't mutate hook
   returns" heuristic doesn't model it. */
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useIsFocused } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';

import { VideoOverlays } from '@/components/video-overlays';
import { parseVideoOverlays } from '@/lib/video-overlays';
import { useEffect, useRef, useState, useMemo } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import type { DeckCard } from '@/lib/deck';
import { mediaSource } from '@/lib/media';
import { getMuted, setMutedPreference, subscribeMute } from '@/lib/mute-preference';
import { cachedVideoUri } from '@/lib/video-cache';
import { reportVideoCompleted, reportVideoPosition } from '@/lib/video-progress';

const VIDEO_CAP_SECONDS = 60;

/** Full-bleed media for a card. Video plays only while the card is focused (the top card). */
export function CardMedia({ card, isActive }: { card: DeckCard; isActive: boolean }) {
  if (card.media_type === 'video') {
    return <CardVideo card={card} isActive={isActive} />;
  }
  return <CardImage card={card} />;
}

function CardImage({ card }: { card: DeckCard }) {
  return (
    <Image
      source={mediaSource(card.media_url)}
      style={StyleSheet.absoluteFill}
      contentFit="cover"
      transition={180}
      recyclingKey={card.id}
      accessibilityRole="image"
      // Surface the poster's alt text to screen readers.
      accessibilityLabel={card.alt_text || card.caption || 'Post image'}
    />
  );
}

function CardVideo({ card, isActive }: { card: DeckCard; isActive: boolean }) {
  const overlays = useMemo(() => parseVideoOverlays(card.overlays), [card.overlays]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // Mute follows the global, persisted preference — an unmute carries to the next card and
  // across sessions rather than resetting per card.
  const [muted, setMuted] = useState(getMuted());

  // Pause while another screen covers the deck (profile, comments, tag page…) — the
  // top card otherwise kept looping, and an uncached loop keeps streaming.
  const focused = useIsFocused();
  const shouldPlay = isActive && focused;

  // The player starts EMPTY and loads its source the first time this card is the top
  // card. The card underneath used to mount with the remote URL and buffer while paused —
  // streaming a clip that was often also being prefetched (the same bytes twice), or that
  // a left-swipe discarded unwatched. cachedVideoUri resolves at activation, so a Wi-Fi
  // pre-download that finished in the meantime plays from disk (instant, offline-safe).
  const loaded = useRef(false);
  const player = useVideoPlayer(null, (p) => {
    p.loop = true;
    p.muted = getMuted();
    p.timeUpdateEventInterval = 1;
  });

  // Keep this card's player in sync when another card changes the shared mute preference.
  useEffect(() => subscribeMute((m) => {
    player.muted = m;
    setMuted(m);
  }), [player]);

  // Only the focused card plays; muting honours the global preference (no forced re-mute).
  useEffect(() => {
    if (shouldPlay && !loaded.current) {
      loaded.current = true;
      player
        .replaceAsync(cachedVideoUri(card.media_url))
        .then(() => {
          player.muted = getMuted();
          player.play();
        })
        .catch(() => {
          loaded.current = false; // retry on the next activation
        });
    } else if (shouldPlay) {
      player.muted = getMuted();
      player.play();
    } else {
      player.pause();
    }
  }, [shouldPlay, player, card.media_url]);

  // Pause when the app backgrounds; resume on return if this card is still focused.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        if (shouldPlay) player.play();
      } else {
        player.pause();
      }
    });
    return () => sub.remove();
  }, [shouldPlay, player]);

  // Enforce the 60s cap: loop back to the start once a clip passes the cap.
  // The same tick feeds watch-time tracking (Part 1B): the view-event recorder
  // reads the last-known position at swipe time via lib/video-progress.
  useEffect(() => {
    const sub = player.addListener('timeUpdate', ({ currentTime }) => {
      reportVideoPosition(card.id, currentTime, player.duration);
      if (currentTime >= VIDEO_CAP_SECONDS) player.currentTime = 0;
    });
    return () => sub.remove();
  }, [card.id, player]);

  // "Watched to the end": playToEnd fires at the natural end of the clip
  // (looping restarts also mark completion inside reportVideoPosition).
  useEffect(() => {
    const sub = player.addListener('playToEnd', () => reportVideoCompleted(card.id));
    return () => sub.remove();
  }, [card.id, player]);

  function toggleMute() {
    const next = !muted;
    player.muted = next;
    setMuted(next);
    setMutedPreference(next); // persist across cards + sessions
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Poster frame under the video so there's no black flash before it loads. */}
      <Image
        source={mediaSource(card.thumbnail_url)}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        recyclingKey={card.id}
        accessibilityRole="image"
        accessibilityLabel={card.alt_text || card.caption || 'Post video'}
      />
      {/* pointerEvents="none": VideoView is a native view that otherwise swallows
          touches at the native layer — above the JS overlay — so the like/skip/comment
          controls stopped responding on video cards. Making it transparent to touches
          lets the overlay controls (and the mute button below) receive taps. This is
          the fix for the "controls dead on video cards" bug, not moving the overlay. */}
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {/* Poster's text/stickers, drawn over the player at normalised positions. */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <VideoOverlays overlays={overlays} width={box.w} height={box.h} />
      </View>
      {/* Mute is now a discrete button rather than a tap-anywhere target, so it no
          longer competes with double-tap-to-like or the card's other tap targets. */}
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
  muteBadge: {
    position: 'absolute',
    bottom: 16,
    right: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 999,
    padding: 8,
  },
});
