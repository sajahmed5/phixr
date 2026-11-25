import type { Session } from '@supabase/supabase-js';

import { secureStoreAdapter } from '@/lib/secure-store-adapter';

/**
 * Part 11: the device account vault.
 *
 * Up to `max_linked_accounts` accounts can be signed in at once. Each slot
 * holds the account's token pair in SecureStore (Keychain/Keystore — never
 * plain storage), and a small metadata list drives the switcher sheet.
 * Linking lives ON THIS DEVICE ONLY: nothing server-side ever ties the
 * accounts together for other users (the moderator-only ban-evasion signal
 * is a separate hashed-device table).
 */

const VAULT_KEY = 'phixr.accounts.v1';
const slotKey = (userId: string) => `phixr.account-session.${userId.replace(/[^a-zA-Z0-9-]/g, '')}`;

export type LinkedAccount = {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  age_band: string;
  /** Last-known unread notification count (refreshed while the account is active). */
  unread: number;
  last_used: string; // ISO
};

export async function listAccounts(): Promise<LinkedAccount[]> {
  try {
    const raw = await secureStoreAdapter.getItem(VAULT_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as LinkedAccount[];
    return [...list].sort((a, b) => (a.last_used < b.last_used ? 1 : -1));
  } catch {
    return [];
  }
}

async function writeVault(list: LinkedAccount[]): Promise<void> {
  await secureStoreAdapter.setItem(VAULT_KEY, JSON.stringify(list));
}

/** Upsert the ACTIVE account's slot: token pair + switcher metadata. */
export async function saveAccountSlot(
  session: Session,
  meta: Omit<LinkedAccount, 'user_id' | 'unread' | 'last_used'> & { unread?: number },
): Promise<void> {
  const userId = session.user.id;
  await secureStoreAdapter.setItem(
    slotKey(userId),
    JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
  );
  const list = await listAccounts();
  const existing = list.find((a) => a.user_id === userId);
  const next: LinkedAccount = {
    user_id: userId,
    handle: meta.handle,
    display_name: meta.display_name,
    avatar_url: meta.avatar_url,
    age_band: meta.age_band,
    unread: meta.unread ?? existing?.unread ?? 0,
    last_used: new Date().toISOString(),
  };
  await writeVault([next, ...list.filter((a) => a.user_id !== userId)]);
}

/** The stored token pair for a slot (null if evicted/corrupted). */
export async function getAccountTokens(
  userId: string,
): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const raw = await secureStoreAdapter.getItem(slotKey(userId));
    return raw ? (JSON.parse(raw) as { access_token: string; refresh_token: string }) : null;
  } catch {
    return null;
  }
}

/** Keep the active slot's tokens current after supabase refreshes them. */
export async function updateSlotTokens(session: Session): Promise<void> {
  const list = await listAccounts();
  if (!list.some((a) => a.user_id === session.user.id)) return; // not vaulted yet
  await secureStoreAdapter.setItem(
    slotKey(session.user.id),
    JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
  );
}

export async function setAccountUnread(userId: string, unread: number): Promise<void> {
  const list = await listAccounts();
  const hit = list.find((a) => a.user_id === userId);
  if (!hit || hit.unread === unread) return;
  hit.unread = unread;
  await writeVault(list);
}

export async function removeAccount(userId: string): Promise<void> {
  await secureStoreAdapter.removeItem(slotKey(userId));
  await writeVault((await listAccounts()).filter((a) => a.user_id !== userId));
}

export async function clearVault(): Promise<void> {
  for (const a of await listAccounts()) {
    await secureStoreAdapter.removeItem(slotKey(a.user_id));
  }
  await secureStoreAdapter.removeItem(VAULT_KEY);
}

// ---------------------------------------------------------------------------
// Switch barrier: anything holding unsent per-account state (swipe queue,
// view events) registers a flusher. switchAccount() drains them BEFORE the
// session changes, so one account's queued actions can never be written
// under another account's session.
// ---------------------------------------------------------------------------
const flushers = new Set<() => Promise<void>>();

export function registerSwitchFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function drainBeforeSwitch(): Promise<void> {
  await Promise.all([...flushers].map((f) => f().catch(() => {})));
}
