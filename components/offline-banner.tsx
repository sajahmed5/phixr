import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOnline } from '@/lib/connectivity';
import { useOutbox } from '@/lib/outbox-provider';

/**
 * App-wide connection banner. Offline, it says so and how much is waiting to go
 * (posts and messages saved on the phone; swipes are queued too). Back online, a saved
 * post that has just gone up gets a short "it's live" confirmation, since the person
 * may have left the app long before it finished. Announced to screen readers as an alert.
 */
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const online = useOnline();
  const { posts, messages } = useOutbox();
  const [justPosted, setJustPosted] = useState<'post' | 'draft' | null>(null);

  const waitingPosts = posts.filter((p) => p.status === 'waiting' || p.status === 'sending').length;
  const waitingMsgs = messages.filter((m) => m.status === 'waiting' || m.status === 'sending').length;

  // Show "it's live" once per outbox item that finishes while the app is open.
  const announced = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = posts.find(
      (p) => p.status === 'done' && !announced.current.has(p.id) && Date.now() - (p.doneAt ?? 0) < 10_000,
    );
    if (!fresh) return;
    const t = setTimeout(() => {
      announced.current.add(fresh.id);
      setJustPosted(fresh.intent);
    }, 0);
    return () => clearTimeout(t);
  }, [posts]);
  useEffect(() => {
    if (!justPosted) return;
    const t = setTimeout(() => setJustPosted(null), 4000);
    return () => clearTimeout(t);
  }, [justPosted]);

  // A small pill floating above the tab bar, never a full-width bar over the top: a bar
  // there covered screen headers (Done / Back / Next) and swallowed their taps. It also
  // lets every touch through, so nothing underneath is ever blocked.
  const position = { bottom: insets.bottom + 92 };

  if (online && justPosted) {
    const text = justPosted === 'post' ? 'Your saved post is now live' : 'Your saved draft is in Drafts';
    return (
      <View style={[styles.wrap, position]} pointerEvents="none">
        <View style={[styles.pill, styles.success]} accessibilityRole="alert" accessibilityLabel={text}>
          <Ionicons name="checkmark-circle" size={15} color="#fff" />
          <Text style={styles.text}>{text}</Text>
        </View>
      </View>
    );
  }

  if (online) return null;

  const parts: string[] = [];
  if (waitingPosts) parts.push(`${waitingPosts} post${waitingPosts === 1 ? '' : 's'}`);
  if (waitingMsgs) parts.push(`${waitingMsgs} message${waitingMsgs === 1 ? '' : 's'}`);
  const text = parts.length
    ? `Offline · ${parts.join(' and ')} will send when you're back`
    : 'Offline · everything will sync when you’re back';

  return (
    <View style={[styles.wrap, position]} pointerEvents="none">
      <View style={styles.pill} accessibilityRole="alert" accessibilityLabel={text}>
        <Ionicons name="cloud-offline-outline" size={14} color="#fff" />
        <Text style={styles.text} numberOfLines={1}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 1000,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(28,28,30,0.92)',
    maxWidth: '100%',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  success: { backgroundColor: '#2E7D46' },
  text: { color: '#fff', fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
});
