import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { STORY_RING_SEEN, BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { getStoriesRail, type RailItem } from '@/lib/stories';
import { supabase } from '@/lib/supabase';

const RING = 64;
// Part 14B: close-friends green — OWNER-ONLY. Viewers always get the normal
// ring; nothing in any payload tells a viewer a story is group-limited.
const RING_CLOSE_FRIENDS = '#2E7D46';

export function StoriesRail() {
  const theme = useTheme();
  const [items, setItems] = useState<RailItem[]>([]);
  const [ownGroupStory, setOwnGroupStory] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getStoriesRail()
        .then((r) => alive && setItems(r))
        .catch(() => {});
      // Own stories only (RLS): is any live one group-limited? Owner ring hint.
      void (async () => {
        const { data: u } = await supabase.auth.getUser();
        if (!u.user) return;
        const { data } = await supabase
          .from('stories')
          .select('audience')
          .eq('user_id', u.user.id)
          .gt('expires_at', new Date().toISOString())
          .eq('audience', 'groups')
          .limit(1);
        if (alive) setOwnGroupStory((data ?? []).length > 0);
      })();
      return () => {
        alive = false;
      };
    }, []),
  );

  const withStories = items.filter((i) => i.has_story).map((i) => i.user_id);
  const openViewer = (userId: string) =>
    router.push({ pathname: '/story/[userId]', params: { userId, ids: withStories.join(',') } });
  const create = () => router.push({ pathname: '/camera', params: { dest: 'story' } });

  const self = items.find((i) => i.is_self);
  const others = items.filter((i) => !i.is_self);

  return (
    <View style={[styles.container, { borderBottomColor: theme.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* Container is a plain View: the avatar and the "+" are SIBLING buttons, never
            nested (nested <button>s are invalid DOM and error on web). */}
        <View style={styles.item}>
          <View
            style={[
              styles.ring,
              // Your own posted story gets a bright ring so you can tell it's live;
              // green means it's limited to your groups (ONLY YOU ever see this).
              { borderColor: self?.has_story ? (ownGroupStory ? RING_CLOSE_FRIENDS : theme.tint) : 'transparent' },
            ]}>
            <Pressable
              onPress={() => (self?.has_story ? openViewer(self.user_id) : create())}
              accessibilityRole="button"
              accessibilityLabel={
                self?.has_story
                  ? ownGroupStory
                    ? 'View your story (shared with your groups only)'
                    : 'View your story'
                  : 'Add to your story'
              }>
              <Avatar uri={self?.avatar_url} theme={theme} />
            </Pressable>
            <Pressable
              onPress={create}
              style={[styles.add, { backgroundColor: BRAND.accent, borderColor: theme.background }]}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Add to your story">
              <Ionicons name="add" size={14} color="#fff" />
            </Pressable>
          </View>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.label}>
            Your story
          </ThemedText>
        </View>

        {others.map((item) => (
          <Pressable
            key={item.user_id}
            style={styles.item}
            onPress={() => openViewer(item.user_id)}
            accessibilityRole="button"
            accessibilityLabel={`View ${item.handle ? `@${item.handle}` : "this person"}'s story${item.has_unviewed ? ', new' : ''}`}>
            <View style={[styles.ring, { borderColor: item.has_unviewed ? theme.tint : STORY_RING_SEEN }]}>
              <Avatar uri={item.avatar_url} theme={theme} />
            </View>
            <ThemedText
              type="small"
              themeColor={item.has_unviewed ? 'text' : 'textSecondary'}
              numberOfLines={1}
              style={styles.label}>
              {item.display_name || item.handle}
            </ThemedText>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function Avatar({ uri, theme }: { uri?: string | null; theme: ReturnType<typeof useTheme> }) {
  if (uri) return <Image source={{ uri }} style={styles.avatar} contentFit="cover" />;
  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor: theme.backgroundSelected, alignItems: 'center', justifyContent: 'center' },
      ]}>
      <Ionicons name="person" size={22} color={theme.textSecondary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderBottomWidth: StyleSheet.hairlineWidth },
  content: { paddingHorizontal: 10, paddingVertical: 8, gap: 12 },
  item: { alignItems: 'center', width: RING + 8 },
  ring: { width: RING, height: RING, borderRadius: RING / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: RING - 8, height: RING - 8, borderRadius: (RING - 8) / 2 },
  add: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { maxWidth: RING + 6, marginTop: 3 },
});
