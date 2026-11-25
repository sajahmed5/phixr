import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus } from 'react-native';

import { getClientSettings, settingNumber } from '@/lib/settings';
import { supabase } from '@/lib/supabase';
import { takeVideoProgress } from '@/lib/video-progress';

/**
 * Watch-time tracking (Part 1B). One event per deck card SHOWN: when it
 * appeared, how long it was on screen before the swipe, the direction
 * ('none' = shown but never swiped — deck left / app closed), and for videos
 * the playback position and completion.
 *
 * Batching: events buffer locally and flush when the buffer reaches
 * view_event_batch_size, every view_event_flush_ms, and when the app
 * backgrounds — never one network call per swipe. Each event carries a
 * client-generated UUID and the server upserts `on conflict do nothing`,
 * so retries after offline/failure can never double count.
 *
 * The dwell clock pauses while the app is backgrounded: a card left open
 * overnight is not a 9-hour view.
 *
 * Privacy notes: the server re-checks everything that matters (public posts
 * only, never your own posts); this class measures, it doesn't decide.
 */

type ViewEvent = {
  id: string;
  post_id: string;
  shown_at: string; // ISO timestamp of when the card became the top card
  dwell_ms: number;
  direction: 'left' | 'right' | 'none';
  video_position_ms?: number;
  video_completed?: boolean;
};

type CurrentView = {
  postId: string;
  isVideo: boolean;
  shownAtIso: string;
  /** Visible-time accumulator (ms) from completed foreground stretches. */
  accumulatedMs: number;
  /** Start of the current foreground stretch, null while backgrounded. */
  visibleSince: number | null;
};

/**
 * Pure-JS UUIDv4. Deliberately not expo-crypto: adding a native module would
 * change the runtime fingerprint and orphan the live TestFlight builds. These
 * ids are idempotency keys, not security tokens — Math.random is plenty.
 */
export function makeEventId(): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i += 1) hex.push(Math.floor(Math.random() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// Never let an offline session grow the stored buffer without bound.
const MAX_BUFFERED = 500;
// Hard cap matching the server's batch limit.
const MAX_PER_FLUSH = 200;

export class ViewEventQueue {
  private storageKey: string;
  private buffer: ViewEvent[] = [];
  private current: CurrentView | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private disposed = false;
  private appStateSub?: { remove: () => void };
  private batchSize = 10;
  private flushMs = 15000;

  constructor(userId: string) {
    this.storageKey = `view-events:${userId}`;
  }

  async init(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(this.storageKey);
      if (raw) this.buffer = JSON.parse(raw) as ViewEvent[];
    } catch {
      // corrupt/absent — start empty
    }
    // Flush cadence comes from platform settings (cached, defaults offline).
    try {
      const settings = await getClientSettings();
      this.batchSize = Math.max(1, settingNumber(settings, 'view_event_batch_size', 10));
      this.flushMs = Math.max(2000, settingNumber(settings, 'view_event_flush_ms', 15000));
    } catch {
      // keep defaults
    }
    if (this.disposed) return;
    this.appStateSub = AppState.addEventListener('change', this.onAppState);
    this.flushTimer = setInterval(() => void this.flush(), this.flushMs);
    void this.flush();
  }

  dispose(): void {
    // The card on screen when the deck unmounts was still a view.
    this.noteTopCard(null);
    this.disposed = true;
    this.appStateSub?.remove();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    void this.flush();
  }

  /**
   * Tell the recorder which card is on top right now (null = none). A change
   * of top card closes the previous view: as 'none' here (the card left the
   * screen without a swipe — deck reloaded, undo, unmount), or with the real
   * direction when noteSwipe() was called first.
   */
  noteTopCard(card: { id: string; media_type: string } | null): void {
    if (this.current?.postId === card?.id) return;
    if (this.current) this.finish('none');
    if (card) {
      this.current = {
        postId: card.id,
        isVideo: card.media_type === 'video',
        shownAtIso: new Date().toISOString(),
        accumulatedMs: 0,
        visibleSince: AppState.currentState === 'active' ? Date.now() : null,
      };
    }
  }

  /** Close the current view with a real swipe direction. */
  noteSwipe(direction: 'left' | 'right'): void {
    if (this.current) this.finish(direction);
  }

  /** Force a flush attempt (e.g. retry button). */
  flushNow(): void {
    void this.flush();
  }

  /** Part 11: awaitable drain for account switching (closes the open view
   *  and lands the buffer under the right account first). */
  async drain(): Promise<void> {
    this.noteTopCard(null);
    while (this.flushing) await new Promise((r) => setTimeout(r, 50));
    await this.flush();
  }

  private onAppState = (state: AppStateStatus) => {
    if (state === 'active') {
      if (this.current && this.current.visibleSince == null) {
        this.current.visibleSince = Date.now();
      }
    } else {
      // Pause the dwell clock and get the buffer to the server while iOS
      // still gives us background grace time.
      if (this.current && this.current.visibleSince != null) {
        this.current.accumulatedMs += Date.now() - this.current.visibleSince;
        this.current.visibleSince = null;
      }
      void this.flush();
    }
  };

  private finish(direction: 'left' | 'right' | 'none'): void {
    const view = this.current;
    this.current = null;
    if (!view) return;
    let dwell = view.accumulatedMs;
    if (view.visibleSince != null) dwell += Date.now() - view.visibleSince;

    const event: ViewEvent = {
      id: makeEventId(),
      post_id: view.postId,
      shown_at: view.shownAtIso,
      dwell_ms: Math.max(0, Math.round(dwell)),
      direction,
    };
    if (view.isVideo) {
      const progress = takeVideoProgress(view.postId);
      if (progress) {
        event.video_position_ms = Math.round(progress.positionMs);
        event.video_completed = progress.completed;
      }
    }

    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFERED) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFERED);
    }
    void this.persist();
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(this.storageKey, JSON.stringify(this.buffer));
    } catch {
      // best-effort persistence
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const batch = this.buffer.slice(0, MAX_PER_FLUSH);
        const { error } = await supabase.rpc('record_view_events', { _events: batch });
        if (error) return; // keep the batch; ids make the retry idempotent
        this.buffer = this.buffer.slice(batch.length);
        await this.persist();
      }
    } catch {
      // offline — retry on the next trigger
    } finally {
      this.flushing = false;
    }
  }
}
