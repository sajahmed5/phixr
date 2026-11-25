/**
 * Tiny bridge between the video player (components/deck/card-media.tsx) and
 * the view-event recorder (lib/view-events.ts): the player reports where
 * playback is; the recorder takes the last-known position at swipe time.
 *
 * Module-level on purpose — the player and the deck hook live in different
 * component trees, and this is transient per-card state, not app state.
 */
type VideoProgress = {
  /** Playback position when last observed (in-loop position, ms). */
  positionMs: number;
  /** Duration if known (ms). */
  durationMs: number | null;
  /** True once the clip played to the end at least once (loops count). */
  completed: boolean;
};

const progress = new Map<string, VideoProgress>();
const MAX_ENTRIES = 50;

export function reportVideoPosition(postId: string, positionSec: number, durationSec: number) {
  const prev = progress.get(postId);
  const durationMs = Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : null;
  const positionMs = Math.max(0, positionSec * 1000);
  // A loop restart (position jumping back) also proves the end was reached.
  const looped = prev != null && positionMs < prev.positionMs - 1500;
  progress.set(postId, {
    positionMs,
    durationMs: durationMs ?? prev?.durationMs ?? null,
    completed: (prev?.completed ?? false) || looped,
  });
  if (progress.size > MAX_ENTRIES) {
    const oldest = progress.keys().next().value;
    if (oldest != null) progress.delete(oldest);
  }
}

export function reportVideoCompleted(postId: string) {
  const prev = progress.get(postId);
  progress.set(postId, {
    positionMs: prev?.positionMs ?? 0,
    durationMs: prev?.durationMs ?? null,
    completed: true,
  });
}

/** Read and clear a card's progress (called once, when its view event is built). */
export function takeVideoProgress(postId: string): VideoProgress | undefined {
  const value = progress.get(postId);
  progress.delete(postId);
  return value;
}
