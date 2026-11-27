import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { track, trackFirst } from '@/lib/analytics';
import { useAuth } from '@/lib/auth-context';
import { isOnline, isUnmeteredConnection, onConnectivityChange } from '@/lib/connectivity';
import { haptics } from '@/lib/haptics';
import {
  arrangeAdPlacement,
  DECK_BATCH_SIZE,
  type DeckCard,
  type FetchBatch,
  type SwipeDirection,
} from '@/lib/deck';
import { registerSwitchFlusher } from '@/lib/accounts';
import { getClientSettings } from '@/lib/settings';
import { prefetchImage, resignDeckMedia, resolveDeckMedia } from '@/lib/media';
import { attachPartnershipLabels } from '@/lib/partnerships';
import { SwipeQueue } from '@/lib/swipe-queue';
import { prefetchVideo } from '@/lib/video-cache';
import { ViewEventQueue } from '@/lib/view-events';

/** 'offline' = nothing left to show and no signal to fetch more (a calm state, not an error). */
export type DeckStatus = 'loading' | 'ready' | 'exhausted' | 'error' | 'offline';

// Start fetching the next batch once the buffer drops to ~card 5 of the current 20.
const REFILL_AT = DECK_BATCH_SIZE - 5;
// Warm the next ~15 cards' media so swiping stays smooth (image bytes are already
// in expo-image's cache by the time the card reaches the top). On metered connections
// stay shallow: full-bleed images are a few hundred KB each, and a user who leaves
// after a couple of cards shouldn't have paid for a dozen more.
const PREFETCH_AHEAD = 15;
const PREFETCH_AHEAD_METERED = 5;
// On Wi-Fi, also download the next few videos so they play instantly — and still play if
// the signal drops. Never on mobile data (see lib/video-cache).
const VIDEO_PREFETCH_AHEAD = 3;
// A saved deck older than this isn't worth showing (posts may be gone or stale).
const SAVED_DECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type SavedDeck = { savedAt: number; cards: DeckCard[] };

export type UseDeckOptions = {
  /** Keep the unseen cards on the phone under this key, so the deck still has something
   *  to show when the app is opened with no signal. Only the main feed sets it. */
  persistKey?: string;
};

export type UseDeck = {
  cards: DeckCard[];
  status: DeckStatus;
  canUndo: boolean;
  pendingWrites: number;
  swipe: (direction: SwipeDirection) => void;
  undo: () => void;
  retry: () => void;
  adjustCommentCount: (id: string, delta: number) => void;
};

/**
 * Owns a swipe deck: candidate buffer, prefetch, optimistic swipes, undo. Feed-agnostic —
 * `fetchBatch` decides which candidate pool (worldwide vs following) fills the buffer;
 * everything downstream (swipe/points/undo/offline queue) is identical across feeds.
 */
export function useDeck(fetchBatch: FetchBatch, options: UseDeckOptions = {}): UseDeck {
  const { user } = useAuth();
  const uid = user?.id;
  const savedKey = uid && options.persistKey ? `deck-buffer:${uid}:${options.persistKey}` : null;

  const [cards, setCards] = useState<DeckCard[]>([]);
  const [status, setStatus] = useState<DeckStatus>('loading');
  const statusRef = useRef<DeckStatus>('loading');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  // Cards restored from the phone carry links that may have expired; re-sign them as soon
  // as there's signal.
  const needsResign = useRef(false);
  // Part 14A: undo the last N swipes (server setting swipe_undo_depth),
  // newest first. The server replaces each undone swipe in analytics.
  const [undoStack, setUndoStack] = useState<DeckCard[]>([]);
  const undoDepth = useRef(3);
  useEffect(() => {
    void getClientSettings()
      .then((cs) => {
        const d = Number((cs as Record<string, unknown>).swipe_undo_depth);
        if (Number.isFinite(d) && d >= 1) undoDepth.current = Math.min(d, 10);
      })
      .catch(() => {});
  }, []);
  const [pendingWrites, setPendingWrites] = useState(0);

  const fetchingMore = useRef(false);
  const queueRef = useRef<SwipeQueue | null>(null);
  const viewQueueRef = useRef<ViewEventQueue | null>(null);
  // Mirror state into refs so analytics can fire OUTSIDE the setState updaters (keeping
  // updaters pure and dodging double-fires under StrictMode / concurrent rendering).
  const cardsRef = useRef<DeckCard[]>([]);
  const undoStackRef = useRef<DeckCard[]>([]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);
  // deck_exhausted: emit once per transition into the exhausted state.
  useEffect(() => {
    if (status === 'exhausted') track('deck_exhausted');
  }, [status]);

  const prefetchMedia = useCallback((list: DeckCard[]) => {
    const ahead = isUnmeteredConnection() ? PREFETCH_AHEAD : PREFETCH_AHEAD_METERED;
    for (const card of list.slice(0, ahead)) {
      // Images: warm the full-bleed image. Videos: warm the poster thumbnail.
      // prefetchImage caches under the stable bucket path and skips keys already on disk.
      const url = card.media_type === 'image' ? card.media_url : card.thumbnail_url;
      if (url) void prefetchImage(url);
    }
    // Wi-Fi only (checked inside): the next few videos themselves. Starts at index 1 —
    // the top card is already mounted and streaming, so downloading it in parallel
    // just fetched the same clip twice.
    for (const card of list.slice(1, 1 + VIDEO_PREFETCH_AHEAD)) {
      if (card.media_type === 'video') prefetchVideo(card.media_url);
    }
  }, []);

  // Fresh links for restored cards (matched by id, so swipes made meanwhile are kept).
  const resignBuffer = useCallback(
    async (list?: DeckCard[]) => {
      const current = list ?? cardsRef.current;
      if (current.length === 0) return;
      try {
        const fresh = await resignDeckMedia(current);
        const byId = new Map(fresh.map((c) => [c.id, c]));
        needsResign.current = false;
        setCards((prev) => prev.map((c) => byId.get(c.id) ?? c));
        prefetchMedia(fresh);
      } catch {
        needsResign.current = true; // try again on the next reconnect
      }
    },
    [prefetchMedia],
  );

  const loadInitial = useCallback(async () => {
    if (!uid) return;
    setStatus('loading');
    try {
      const batch = arrangeAdPlacement(
        await attachPartnershipLabels(await resolveDeckMedia(await fetchBatch([]))),
      );
      needsResign.current = false;
      setCards(batch);
      setUndoStack([]);
      setStatus(batch.length === 0 ? 'exhausted' : 'ready');
      prefetchMedia(batch);
    } catch {
      // No signal (or a server hiccup): fall back to the cards saved on the phone from
      // last time. Their images are already in the image cache, so they show offline;
      // swipes on them queue up and sync later like any other.
      const saved = savedKey ? await readSavedDeck(savedKey) : null;
      if (saved && saved.cards.length > 0) {
        needsResign.current = true;
        setCards(saved.cards);
        setUndoStack([]);
        setStatus('ready');
        if (isOnline()) void resignBuffer(saved.cards);
        return;
      }
      setStatus(isOnline() ? 'error' : 'offline');
    }
  }, [uid, fetchBatch, prefetchMedia, savedKey, resignBuffer]);

  const fetchMore = useCallback(async () => {
    if (fetchingMore.current) return;
    fetchingMore.current = true;
    try {
      // Exclude only what the server can't know about: cards still in the buffer or
      // undo stack, and swipes that haven't synced yet. (Synced swipes are already
      // excluded server-side — sending every id ever loaded grew this request without
      // bound over a long session.)
      const exclude = new Set<string>([
        ...cardsRef.current.map((c) => c.id),
        ...undoStackRef.current.map((c) => c.id),
        ...(queueRef.current?.pendingSwipePostIds ?? []),
      ]);
      const batch = await fetchBatch([...exclude]);
      const fresh = await attachPartnershipLabels(
        await resolveDeckMedia(batch.filter((c) => !exclude.has(c.id))),
      );
      // Aggregate count only — never which cards, never who they're for.
      track('batch_refetch', { size: fresh.length });
      if (fresh.length) {
        setCards((prev) => {
          // Part 13D: place the batch's ad away from sensitive/blocked cards,
          // checking the boundary against the last card already dealt.
          const have = new Set(prev.map((c) => c.id));
          const placed = arrangeAdPlacement(fresh.filter((c) => !have.has(c.id)), prev[prev.length - 1] ?? null);
          const next = [...prev, ...placed];
          // Warm from the head of the MERGED buffer — the new batch lands ~15 cards
          // deep, so prefetching it directly downloaded media far from being seen.
          prefetchMedia(next);
          return next;
        });
      }
      // Mark exhausted only when nothing new AND the buffer has drained.
      setCards((prev) => {
        if (fresh.length === 0 && prev.length === 0) setStatus('exhausted');
        return prev;
      });
    } catch {
      // A background refill failure shouldn't blow away a usable buffer; only surface a
      // state when there's nothing to show — the calm offline one if the signal is gone.
      setCards((prev) => {
        if (prev.length === 0) setStatus(isOnline() ? 'error' : 'offline');
        return prev;
      });
    } finally {
      fetchingMore.current = false;
    }
  }, [fetchBatch, prefetchMedia]);

  // Signal is back: refresh expired links on restored cards, top the buffer up, or load
  // a fresh deck if it ran dry — without the user having to tap Retry.
  useEffect(
    () =>
      onConnectivityChange((online) => {
        if (!online || !uid) return;
        if (needsResign.current) void resignBuffer();
        const n = cardsRef.current.length;
        if (n === 0) {
          if (statusRef.current === 'offline' || statusRef.current === 'error') void loadInitial();
        } else if (n <= REFILL_AT) {
          void fetchMore();
        }
      }),
    [uid, loadInitial, fetchMore, resignBuffer],
  );

  // Keep the unseen cards on the phone (main feed only) for the next offline launch.
  useEffect(() => {
    if (!savedKey || status !== 'ready') return;
    const t = setTimeout(() => {
      void writeSavedDeck(savedKey, { savedAt: Date.now(), cards: cards.slice(0, DECK_BATCH_SIZE) });
    }, 500);
    return () => clearTimeout(t);
  }, [cards, status, savedKey]);

  // Bootstrap: swipe queue + view-event recorder + first batch, per user.
  useEffect(() => {
    if (!uid) return;
    const queue = new SwipeQueue(uid, setPendingWrites);
    queueRef.current = queue;
    void queue.init();
    const viewQueue = new ViewEventQueue(uid);
    viewQueueRef.current = viewQueue;
    void viewQueue.init();
    // Part 11: before an account switch, both queues drain under THIS account.
    const unregisterFlusher = registerSwitchFlusher(async () => {
      await Promise.all([queue.drain(), viewQueue.drain()]);
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInitial();
    return () => {
      unregisterFlusher();
      queue.dispose();
      queueRef.current = null;
      // Closes the in-progress view as 'none' and flushes the buffer.
      viewQueue.dispose();
      viewQueueRef.current = null;
    };
  }, [uid, loadInitial]);

  // Watch-time tracking (Part 1B): the top card is "the card being shown".
  // A change of top card opens the next view; the previous one was already
  // closed with its real direction by `swipe`, or closes as 'none' here
  // (deck reload / undo / nothing left).
  useEffect(() => {
    const top = cards[0];
    viewQueueRef.current?.noteTopCard(
      top ? { id: top.id, media_type: top.media_type } : null,
    );
  }, [cards]);

  const swipe = useCallback(
    (direction: SwipeDirection) => {
      // Emit BEFORE mutating state. `direction` only — NEVER the post id, so no
      // post↔swiper pair can ever be reconstructed by the analytics backend.
      if (cardsRef.current.length > 0) {
        haptics.light(); // light tap on a committed swipe
        track('swipe', { direction });
        if (uid) void trackFirst(uid, 'first_swipe');
        // Close the top card's view event with its real direction (dwell is
        // measured inside the recorder; the batch flushes on its own cadence).
        viewQueueRef.current?.noteSwipe(direction);
      }
      setCards((prev) => {
        if (prev.length === 0) return prev;
        const [top, ...rest] = prev;
        setUndoStack((st) => [top, ...st].slice(0, undoDepth.current));
        queueRef.current?.enqueueSwipe(top.id, direction);
        prefetchMedia(rest);
        if (rest.length <= REFILL_AT) void fetchMore();
        if (rest.length === 0) void fetchMore();
        return rest;
      });
    },
    [fetchMore, prefetchMedia, uid],
  );

  const undo = useCallback(() => {
    if (undoStackRef.current.length > 0) {
      haptics.light();
      track('undo_used');
    }
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const [last, ...rest] = prev;
      queueRef.current?.enqueueUndo(last.id);
      setCards((cs) => [last, ...cs]);
      setStatus((s) => (s === 'exhausted' || s === 'offline' ? 'ready' : s));
      return rest; // up to swipe_undo_depth steps back
    });
  }, []);

  const retry = useCallback(() => {
    void loadInitial();
    queueRef.current?.flush();
  }, [loadInitial]);

  // Keep a card's comment count roughly in sync while its comment sheet is open.
  const adjustCommentCount = useCallback((id: string, delta: number) => {
    setCards((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, comment_count: Math.max(0, c.comment_count + delta) } : c,
      ),
    );
  }, []);

  return {
    cards,
    status,
    canUndo: undoStack.length > 0,
    pendingWrites,
    swipe,
    undo,
    retry,
    adjustCommentCount,
  };
}

async function readSavedDeck(key: string): Promise<SavedDeck | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedDeck;
    if (!Array.isArray(saved.cards) || Date.now() - saved.savedAt > SAVED_DECK_MAX_AGE_MS) return null;
    return saved;
  } catch {
    return null;
  }
}

async function writeSavedDeck(key: string, deck: SavedDeck): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(deck));
  } catch {
    // best effort
  }
}
