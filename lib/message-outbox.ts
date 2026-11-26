import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { isOnline, isPermanentServerError } from '@/lib/connectivity';
import { discardOutboxFiles, keepForOutbox, outboxFileExists } from '@/lib/offline-files';
import { supabase } from '@/lib/supabase';
import { UploadFailed, UploadRejected, uploadToPipeline } from '@/lib/upload';

/**
 * Messages written while the signal is weak or gone. Each one is saved on the phone at
 * once (text, any attached image, which chat, who it replies to), shown in the chat with a
 * "waiting" clock, and sent in order as soon as the connection returns — surviving leaving
 * the chat and closing the app.
 *
 * Every queued message carries a client id that the server uses to recognise a repeat
 * (migration 20261126100000), so a retry after a lost response can never deliver the
 * same message twice.
 *
 * One outbox per account (Part 11): items are keyed by user and only ever sent while that
 * account is the signed-in one.
 */

export type QueuedMessage = {
  clientId: string;
  userId: string;
  cid: string;
  /** Business id when a team member replies as the business (text only). */
  asBusiness: string | null;
  body: string | null;
  /** Durable local copy of an attached image, until uploaded. */
  mediaUri: string | null;
  /** Set once the image has been through the pipeline, so a retry doesn't re-upload. */
  mediaUrl: string | null;
  replyToId: string | null;
  createdAt: string;
  status: 'waiting' | 'sending' | 'sent' | 'failed';
  /** Plain-words reason for a message that can't be sent. */
  error: string | null;
  /** The real message id once delivered (lets the chat swap the bubble seamlessly). */
  sentId: string | null;
  sentAt: number | null;
};

type Listener = (items: QueuedMessage[]) => void;

/** Delivered items linger briefly so an open chat can swap the bubble without a flicker. */
const SENT_LINGER_MS = 60_000;

export class MessageOutbox {
  private items: QueuedMessage[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private disposed = false;
  // A send that failed for lack of signal is retried on its own, backing off from 15 s to
  // 5 min — the phone may never report a change in connection on a merely weak signal.
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 15_000;
  private readonly key: string;

  constructor(private readonly userId: string) {
    this.key = `message-outbox:${userId}`;
  }

  async init(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(this.key);
      if (raw) this.items = JSON.parse(raw) as QueuedMessage[];
    } catch {
      this.items = [];
    }
    // Anything that was mid-send when the app closed goes back in line.
    this.items = this.items
      .map((m) => (m.status === 'sending' ? { ...m, status: 'waiting' as const } : m))
      .filter((m) => !(m.status === 'sent' && Date.now() - (m.sentAt ?? 0) > SENT_LINGER_MS));
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

  getItems(): QueuedMessage[] {
    return this.items;
  }

  enqueue(input: {
    cid: string;
    asBusiness?: string | null;
    body?: string | null;
    mediaUri?: string | null;
    replyToId?: string | null;
  }): QueuedMessage {
    const clientId = Crypto.randomUUID();
    const item: QueuedMessage = {
      clientId,
      userId: this.userId,
      cid: input.cid,
      asBusiness: input.asBusiness ?? null,
      body: input.body?.trim() || null,
      mediaUri: input.mediaUri ? keepForOutbox(clientId, 0, input.mediaUri, 'image') : null,
      mediaUrl: null,
      replyToId: input.replyToId ?? null,
      createdAt: new Date().toISOString(),
      status: 'waiting',
      error: null,
      sentId: null,
      sentAt: null,
    };
    this.items = [...this.items, item];
    void this.persist();
    this.emit();
    void this.process();
    return item;
  }

  /** Try a message that couldn't be sent again (e.g. after the user fixed the reason). */
  retry(clientId: string): void {
    this.update(clientId, { status: 'waiting', error: null });
    void this.process();
  }

  remove(clientId: string): void {
    this.items = this.items.filter((m) => m.clientId !== clientId);
    discardOutboxFiles(clientId);
    void this.persist();
    this.emit();
  }

  /** Nudge: called on reconnect / foreground. */
  flush(): void {
    void this.process();
  }

  /** Account switch: send what we can under THIS account before the session changes. */
  async drain(): Promise<void> {
    while (this.running) await new Promise((r) => setTimeout(r, 50));
    await this.process();
  }

  private async process(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      this.pruneSent();
      for (;;) {
        const next = this.items.find((m) => m.status === 'waiting');
        if (!next || !isOnline() || this.disposed) break;
        // Never send from the wrong account (an account switch is mid-flight).
        const { data } = await supabase.auth.getSession();
        if (data.session?.user.id !== this.userId) break;

        this.update(next.clientId, { status: 'sending' });
        const outcome = await this.sendOne(next);
        if (outcome === 'retry-later') {
          this.scheduleRetry();
          this.update(next.clientId, { status: 'waiting' });
          break; // keep order: nothing jumps ahead of a message still waiting for signal
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async sendOne(m: QueuedMessage): Promise<'done' | 'retry-later'> {
    try {
      let mediaUrl = m.mediaUrl;
      if (m.mediaUri && !mediaUrl) {
        if (!outboxFileExists(m.mediaUri)) {
          this.update(m.clientId, { status: 'failed', error: 'The photo is no longer on this phone.' });
          return 'done';
        }
        // Same pipeline as posts: EXIF strip + safety scan. Blocked images are never sent.
        const result = await uploadToPipeline(
          { uri: m.mediaUri, type: 'image', mime: 'image/jpeg' },
          () => {},
        );
        if (result.moderation_status === 'flagged' || result.moderation_status === 'removed') {
          this.update(m.clientId, { status: 'failed', error: 'That image was blocked by our safety check.' });
          discardOutboxFiles(m.clientId);
          return 'done';
        }
        mediaUrl = result.media_url;
        this.update(m.clientId, { mediaUrl });
      }

      let sentId: string;
      if (m.asBusiness) {
        const { sendMessageAsBusiness } = await import('@/lib/business');
        sentId = await sendMessageAsBusiness(m.asBusiness, m.cid, m.body ?? '', m.clientId);
      } else {
        const { sendMessage } = await import('@/lib/messages');
        sentId = await sendMessage(m.cid, {
          body: m.body ?? undefined,
          mediaUrl: mediaUrl ?? undefined,
          replyToId: m.replyToId ?? undefined,
          clientId: m.clientId,
        });
      }
      this.update(m.clientId, { status: 'sent', sentId, sentAt: Date.now(), error: null });
      this.retryDelay = 15_000;
      discardOutboxFiles(m.clientId);
      return 'done';
    } catch (e) {
      if (e instanceof UploadRejected) {
        this.update(m.clientId, { status: 'failed', error: 'That image was blocked by our safety check.' });
        discardOutboxFiles(m.clientId);
        return 'done';
      }
      if (e instanceof UploadFailed && !e.retryable) {
        this.update(m.clientId, { status: 'failed', error: e.message });
        return 'done';
      }
      if (isPermanentServerError(e)) {
        this.update(m.clientId, { status: 'failed', error: friendlyReason(e) });
        return 'done';
      }
      return 'retry-later';
    }
  }

  private pruneSent(): void {
    const before = this.items.length;
    this.items = this.items.filter(
      (m) => !(m.status === 'sent' && Date.now() - (m.sentAt ?? 0) > SENT_LINGER_MS),
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

  private update(clientId: string, patch: Partial<QueuedMessage>): void {
    this.items = this.items.map((m) => (m.clientId === clientId ? { ...m, ...patch } : m));
    void this.persist();
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

function friendlyReason(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? '');
  if (msg.includes('not_allowed')) return "This person can't receive messages from you.";
  if (msg.includes('request_pending')) return 'They need to accept your message request first.';
  if (msg.includes('not_a_member') || msg.includes('not authorised'))
    return "You're no longer in this conversation.";
  if (msg.includes('safety')) return 'That message was blocked by our safety check.';
  return "This message couldn't be sent.";
}
