import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';

import { track, trackFirst } from '@/lib/analytics';
import { useAuth } from '@/lib/auth-context';
import { haptics } from '@/lib/haptics';
import {
  arrangeAdPlacement,
  DECK_BATCH_SIZE,
  type DeckCard,
  type FetchBatch,
  type SwipeDirection,
} from '@/lib/deck';
import { registerSwitchFlusher } from '@/lib/accounts';
import { resolveDeckMedia } from '@/lib/media';
import { attachPartnershipLabels } from '@/lib/partnerships';
import { SwipeQueue } from '@/lib/swipe-queue';
import { ViewEventQueue } from '@/lib/view-events';

export type DeckStatus = 'loading' | 'ready' | 'exhausted' | 'error';

// Start fetching the next batch once the buffer drops to ~card 5 of the current 20.
const REFILL_AT = DECK_BATCH_SIZE - 5;
// Warm the media for the next few cards so they don't pop in.
// Warm the next ~15 cards' media so swiping stays smooth (image bytes are already
// in expo-image's cache by the time the card reaches the top).
const PREFETCH_AHEAD = 15;

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
export function useDeck(fetchBatch: FetchBatch): UseDeck {
  const { user } = useAuth();
  const uid = user?.id;

  const [cards, setCards] = useState<DeckCard[]>([]);
  const [status, setStatus] = useState<DeckStatus>('loading');
  const [lastSwiped, setLastSwiped] = useState<DeckCard | null>(null);
  const [pendingWrites, setPendingWrites] = useState(0);

  // All post ids ever loaded this session — passed as the deck's exclude list so the
  // server never re-serves a card already in (or already gone from) the buffer.
  const loadedIds = useRef<Set<string>>(new Set());
  const fetchingMore = useRef(false);
  const queueRef = useRef<SwipeQueue | null>(null);
  const viewQueueRef = useRef<ViewEventQueue | null>(null);
  // Mirror state into refs so analytics can fire OUTSIDE the setState updaters (keeping
  // updaters pure and dodging double-fires under StrictMode / concurrent rendering).
  const cardsRef = useRef<DeckCard[]>([]);
  const lastSwipedRef = useRef<DeckCard | null>(null);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  useEffect(() => {
    lastSwipedRef.current = lastSwiped;
  }, [lastSwiped]);
  // deck_exhausted: emit once per transition into the exhausted state.
  useEffect(() => {
    if (status === 'exhausted') track('deck_exhausted');
  }, [status]);

  const prefetchMedia = useCallback((list: DeckCard[]) => {
    for (const card of list.slice(0, PREFETCH_AHEAD)) {
      // Images: warm the full-bleed image. Videos: warm the poster thumbnail.
      const url = card.media_type === 'image' ? card.media_url : card.thumbnail_url;
      if (url) void Image.prefetch(url);
    }
  }, []);

  const loadInitial = useCallback(async () => {
    if (!uid) return;
    setStatus('loading');
    loadedIds.current = new Set();
    try {
      const batch = arrangeAdPlacement(
        await attachPartnershipLabels(await resolveDeckMedia(await fetchBatch([]))),
      );
      batch.forEach((c) => loadedIds.current.add(c.id));
      setCards(batch);
      setLastSwiped(null);
      setStatus(batch.length === 0 ? 'exhausted' : 'ready');
      prefetchMedia(batch);
    } catch {
      setStatus('error');
    }
  }, [uid, fetchBatch, prefetchMedia]);

  const fetchMore = useCallback(async () => {
    if (fetchingMore.current) return;
    fetchingMore.current = true;
    try {
      const batch = await fetchBatch([...loadedIds.current]);
      const fresh = await attachPartnershipLabels(
        await resolveDeckMedia(batch.filter((c) => !loadedIds.current.has(c.id))),
      );
      fresh.forEach((c) => loadedIds.current.add(c.id));
      // Aggregate count only — never which cards, never who they're for.
      track('batch_refetch', { size: fresh.length });
      if (fresh.length) {
        setCards((prev) => {
          // Part 13D: place the batch's ad away from sensitive/blocked cards,
          // checking the boundary against the last card already dealt.
          const placed = arrangeAdPlacement(fresh, prev[prev.length - 1] ?? null);
          const next = [...prev, ...placed];
          // Warm the freshly-arrived batch's media (not just when the deck was empty).
          prefetchMedia(placed);
          return next;
        });
      }
      // Mark exhausted only when nothing new AND the buffer has drained.
      setCards((prev) => {
        if (fresh.length === 0 && prev.length === 0) setStatus('exhausted');
        return prev;
      });
    } catch {
      // A background refill failure shouldn't blow away a usable buffer; only surface an
      // error when there's nothing to show.
      setCards((prev) => {
        if (prev.length === 0) setStatus('error');
        return prev;
      });
    } finally {
      fetchingMore.current = false;
    }
  }, [fetchBatch, prefetchMedia]);

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
        setLastSwiped(top);
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
    if (lastSwipedRef.current) {
      haptics.light();
      track('undo_used');
    }
    setLastSwiped((prev) => {
      if (!prev) return null;
      queueRef.current?.enqueueUndo(prev.id);
      setCards((cs) => [prev, ...cs]);
      setStatus((s) => (s === 'exhausted' ? 'ready' : s));
      return null; // single step back only
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
    canUndo: lastSwiped !== null,
    pendingWrites,
    swipe,
    undo,
    retry,
    adjustCommentCount,
  };
}
