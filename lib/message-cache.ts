import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Conversation, ConversationDetail, Message } from '@/lib/messages';

/**
 * Last-seen copies of the inbox and of each open chat, so they still open with no
 * signal (and new messages can be written — they wait in the outbox). Per account, never
 * shared between accounts on the same phone. Only the most recent page is kept.
 */

const THREAD_KEEP = 30;

const threadKey = (uid: string, cid: string) => `thread-cache:${uid}:${cid}`;
const inboxKey = (uid: string) => `inbox-cache:${uid}`;

export async function saveThread(
  uid: string,
  cid: string,
  detail: ConversationDetail | null,
  messages: Message[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(
      threadKey(uid, cid),
      JSON.stringify({ detail, messages: messages.slice(0, THREAD_KEEP) }),
    );
  } catch {
    // best effort
  }
}

export async function loadThread(
  uid: string,
  cid: string,
): Promise<{ detail: ConversationDetail | null; messages: Message[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(threadKey(uid, cid));
    return raw ? (JSON.parse(raw) as { detail: ConversationDetail | null; messages: Message[] }) : null;
  } catch {
    return null;
  }
}

export async function saveInbox(uid: string, conversations: Conversation[]): Promise<void> {
  try {
    await AsyncStorage.setItem(inboxKey(uid), JSON.stringify(conversations));
  } catch {
    // best effort
  }
}

export async function loadInbox(uid: string): Promise<Conversation[] | null> {
  try {
    const raw = await AsyncStorage.getItem(inboxKey(uid));
    return raw ? (JSON.parse(raw) as Conversation[]) : null;
  } catch {
    return null;
  }
}
