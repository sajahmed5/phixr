import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { registerSwitchFlusher } from '@/lib/accounts';
import { useAuth } from '@/lib/auth-context';
import { onConnectivityChange } from '@/lib/connectivity';
import { MessageOutbox, type QueuedMessage } from '@/lib/message-outbox';
import { PostOutbox, type QueuedPost } from '@/lib/post-outbox';

/**
 * Owns the signed-in account's message and post outboxes: rebuilt on every account change,
 * nudged on reconnect / app foreground, and drained before an account switch so nothing is
 * ever sent under the wrong account.
 */

type OutboxValue = {
  messages: QueuedMessage[];
  posts: QueuedPost[];
  enqueueMessage: MessageOutbox['enqueue'];
  retryMessage: (clientId: string) => void;
  removeMessage: (clientId: string) => void;
  enqueuePost: PostOutbox['enqueue'];
  retryPost: (id: string) => void;
  removePost: (id: string) => void;
};

const OutboxContext = createContext<OutboxValue | undefined>(undefined);
const NONE_MSG: QueuedMessage[] = [];
const NONE_POST: QueuedPost[] = [];

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const uid = user?.id;
  const msgRef = useRef<MessageOutbox | null>(null);
  const postRef = useRef<PostOutbox | null>(null);
  const [messages, setMessages] = useState<QueuedMessage[]>([]);
  const [posts, setPosts] = useState<QueuedPost[]>([]);

  useEffect(() => {
    if (!uid) {
      msgRef.current = null;
      postRef.current = null;
      return;
    }
    const mo = new MessageOutbox(uid);
    const po = new PostOutbox(uid);
    msgRef.current = mo;
    postRef.current = po;
    const unsubM = mo.subscribe(setMessages);
    const unsubP = po.subscribe(setPosts);
    void mo.init();
    void po.init();
    const unsubNet = onConnectivityChange((online) => {
      if (!online) return;
      mo.flush();
      po.flush();
    });
    const unregister = registerSwitchFlusher(async () => {
      await Promise.all([mo.drain(), po.drain()]);
    });
    return () => {
      unsubM();
      unsubP();
      unsubNet();
      unregister();
      mo.dispose();
      po.dispose();
    };
  }, [uid]);

  const enqueueMessage = useCallback<MessageOutbox['enqueue']>((input) => {
    const mo = msgRef.current;
    if (!mo) throw new Error('Not signed in.');
    return mo.enqueue(input);
  }, []);
  const enqueuePost = useCallback<PostOutbox['enqueue']>((input) => {
    const po = postRef.current;
    if (!po) throw new Error('Not signed in.');
    return po.enqueue(input);
  }, []);
  const retryMessage = useCallback((id: string) => msgRef.current?.retry(id), []);
  const removeMessage = useCallback((id: string) => msgRef.current?.remove(id), []);
  const retryPost = useCallback((id: string) => postRef.current?.retry(id), []);
  const removePost = useCallback((id: string) => postRef.current?.remove(id), []);

  const value = useMemo<OutboxValue>(
    () => ({
      // Signed out: nothing queued is shown (another account's items never leak).
      messages: uid ? messages : NONE_MSG,
      posts: uid ? posts : NONE_POST,
      enqueueMessage,
      retryMessage,
      removeMessage,
      enqueuePost,
      retryPost,
      removePost,
    }),
    [uid, messages, posts, enqueueMessage, retryMessage, removeMessage, enqueuePost, retryPost, removePost],
  );

  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>;
}

export function useOutbox(): OutboxValue {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error('useOutbox must be used within an OutboxProvider');
  return ctx;
}
