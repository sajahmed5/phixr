import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { trackFirst } from '@/lib/analytics';
import { isOnline, isPermanentServerError } from '@/lib/connectivity';
import { discardOutboxFiles, keepForOutbox, outboxFileExists } from '@/lib/offline-files';
import { supabase } from '@/lib/supabase';
import {
  createPost,
  UploadFailed,
  UploadRejected,
  uploadToPipeline,
  type PickedMedia,
  type PipelineResult,
} from '@/lib/upload';
import type { Draft as ComposeDraft } from '@/lib/upload-manager';
import type { VideoOverlay } from '@/lib/video-overlays';

/**
 * Posts (and drafts) made while the signal is weak or gone. The media is copied into the
 * app's own storage, the caption/tags/audience are saved with it, and it appears in Drafts
 * marked "waiting for connection". When the signal returns it goes through the normal
 * upload pipeline — the same safety scans as any post — and then either publishes
 * (`intent: 'post'`) or lands in the server-side Drafts (`intent: 'draft'`).
 *
 * The post id is generated on the phone, so a retry after a lost response finds the post
 * it already created rather than publishing it twice (see createPost).
 *
 * One outbox per account (Part 11): only ever sent while that account is signed in.
 */

export type QueuedPost = {
  id: string; // also the post id once published
  userId: string;
  intent: 'post' | 'draft';
  createdAt: string;
  /** Durable local copies, cover first (carousel extras after). */
  media: PickedMedia[];
  /** Pipeline results per media item, filled in as each upload finishes. */
  results: (PipelineResult | null)[];
  draft: ComposeDraft;
  overlays: VideoOverlay[];
  status: 'waiting' | 'sending' | 'rejected' | 'failed' | 'done';
  progress: number;
  error: string | null;
  doneAt: number | null;
};

type Listener = (items: QueuedPost[]) => void;

/** Finished items linger briefly so the app can say "your post is live". */
const DONE_LINGER_MS = 60_000;

export class PostOutbox {
  private items: QueuedPost[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private disposed = false;
  // A send that failed for lack of signal is retried on its own, backing off from 15 s to
  // 5 min — the phone may never report a change in connection on a merely weak signal.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 15_000;
  private readonly key: string;

  constructor(private readonly userId: string) {
    this.key = `post-outbox:${userId}`;
  }

  async init(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(this.key);
      if (raw) this.items = JSON.parse(raw) as QueuedPost[];
    } catch {
      this.items = [];
    }
    this.items = this.items
      .map((p) => (p.status === 'sending' ? { ...p, status: 'waiting' as const, progress: 0 } : p))
      .filter((p) => !(p.status === 'done' && Date.now() - (p.doneAt ?? 0) > DONE_LINGER_MS));
    await this.persist();
    this.emit();
    void this.process();
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.items);
    return () => this.listeners.delete(cb);
  }

  getItems(): QueuedPost[] {
    return this.items;
  }

  enqueue(input: {
    intent: 'post' | 'draft';
    media: PickedMedia[];
    results?: (PipelineResult | null)[];
    draft: ComposeDraft;
    overlays: VideoOverlay[];
  }): QueuedPost {
    const id = Crypto.randomUUID();
    const media = input.media.map((m, i) => ({ ...m, uri: keepForOutbox(id, i, m.uri, m.type) }));
    const item: QueuedPost = {
      id,
      userId: this.userId,
      intent: input.intent,
      createdAt: new Date().toISOString(),
      media,
      results: media.map((_, i) => input.results?.[i] ?? null),
      draft: input.draft,
      overlays: input.overlays,
      status: 'waiting',
      progress: 0,
      error: null,
      doneAt: null,
    };
    this.items = [...this.items, item];
    void this.persist();
    this.emit();
    void this.process();
    return item;
  }

  retry(id: string): void {
    this.update(id, { status: 'waiting', error: null });
    void this.process();
  }

  remove(id: string): void {
    this.items = this.items.filter((p) => p.id !== id);
    discardOutboxFiles(id);
    void this.persist();
    this.emit();
  }

  flush(): void {
    void this.process();
  }

  async drain(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    await this.process();
  }

  private async process(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      this.pruneDone();
      for (;;) {
        const next = this.items.find((p) => p.status === 'waiting');
        if (!next || !isOnline() || this.disposed) break;
        const { data } = await supabase.auth.getSession();
        if (data.session?.user.id !== this.userId) break;

        this.update(next.id, { status: 'sending', error: null });
        const outcome = await this.sendOne(next);
        if (outcome === 'retry-later') {
          this.scheduleRetry();
          this.update(next.id, { status: 'waiting' });
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async sendOne(p: QueuedPost): Promise<'done' | 'retry-later'> {
    try {
      // 1. Upload anything not yet through the pipeline.
      const results = [...p.results];
      const total = p.media.length;
      for (let i = 0; i < total; i++) {
        if (results[i]) continue;
        if (!outboxFileExists(p.media[i].uri)) {
          this.update(p.id, { status: 'failed', error: 'The photo or video is no longer on this phone.' });
          return 'done';
        }
        results[i] = await uploadToPipeline(p.media[i], (frac) =>
          this.update(p.id, { progress: (i + frac) / total }, false),
        );
        this.update(p.id, { results: [...results] });
      }
      const done = results as PipelineResult[];

      // 2. Publish, or save to the server-side Drafts.
      if (p.intent === 'post') {
        await createPost({
          id: p.id,
          result: done[0],
          extras: done.slice(1),
          caption: p.draft.caption,
          altText: p.draft.altText,
          visibility: p.draft.visibility,
          groupIds: p.draft.groupIds,
          attachLocation: p.draft.attachLocation,
          locationCell: p.draft.locationCell,
          tags: p.draft.tags,
          overlays: p.overlays,
        });
        if (p.draft.partnerBrand?.trim()) {
          // ASA disclosure label (Part 9A). The post itself has landed; a failure here is
          // non-fatal, exactly as when posting online.
          try {
            const { declarePartnership } = await import('@/lib/partnerships');
            await declarePartnership(p.id, p.draft.partnerBrand.trim());
          } catch {
            // the owner can add the label from the post menu
          }
        }
        void trackFirst(this.userId, 'first_post');
      } else {
        const { mediaFromPipeline, saveDraft } = await import('@/lib/drafts');
        await saveDraft('post', {
          caption: p.draft.caption,
          alt_text: p.draft.altText,
          visibility: p.draft.visibility,
          group_ids: p.draft.groupIds,
          tags: p.draft.tags,
          attach_location: p.draft.attachLocation,
          location_cell: p.draft.locationCell ?? done[0].suggestions?.location_cell ?? null,
          location_label: p.draft.locationLabel,
          partner_brand: p.draft.partnerBrand,
          overlays: p.overlays as unknown[],
          media: mediaFromPipeline(done),
        });
      }
      this.update(p.id, { status: 'done', progress: 1, doneAt: Date.now() });
      this.retryDelay = 15_000;
      discardOutboxFiles(p.id);
      return 'done';
    } catch (e) {
      if (e instanceof UploadRejected) {
        // Same non-accusatory wording as the composer; thresholds are never revealed.
        this.update(p.id, {
          status: 'rejected',
          error: "This media can't be posted because it doesn't meet our content guidelines.",
        });
        discardOutboxFiles(p.id);
        return 'done';
      }
      if (e instanceof UploadFailed) {
        if (!e.retryable) {
          this.update(p.id, { status: 'failed', error: e.message });
          return 'done';
        }
        return 'retry-later';
      }
      if (isPermanentServerError(e)) {
        this.update(p.id, { status: 'failed', error: "This post couldn't be published." });
        return 'done';
      }
      // A plain validation error from createPost (e.g. the chosen groups were deleted)
      // while we are online won't fix itself on retry.
      if (e instanceof Error && !('code' in e) && isOnline() && !/network|timed out|fetch/i.test(e.message)) {
        this.update(p.id, { status: 'failed', error: e.message });
        return 'done';
      }
      return 'retry-later';
    }
  }

  private pruneDone(): void {
    const before = this.items.length;
    this.items = this.items.filter(
      (p) => !(p.status === 'done' && Date.now() - (p.doneAt ?? 0) > DONE_LINGER_MS),
    );
    if (this.items.length !== before) {
      void this.persist();
      this.emit();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 5 * 60_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.process();
    }, delay);
  }

  private update(id: string, patch: Partial<QueuedPost>, save = true): void {
    this.items = this.items.map((p) => (p.id === id ? { ...p, ...patch } : p));
    if (save) void this.persist();
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this.items);
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(this.key, JSON.stringify(this.items));
    } catch {
      // best effort
    }
  }
}
