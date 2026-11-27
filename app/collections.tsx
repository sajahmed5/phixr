import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ActionMenu } from '@/components/ui/action-menu';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import {
  createCollection,
  deleteCollection,
  getBookmarks,
  getCollections,
  renameCollection,
  reorderCollections,
  setCollectionCover,
  type Collection,
} from '@/lib/bookmarks';
import { confirm } from '@/lib/confirm';
import { mediaSource } from '@/lib/media';

/**
 * Part 14E: manage saved collections — rename, reorder (tap the arrows, same
 * one-handed pattern as the Part 12 calendar), pick a cover from the
 * collection's own posts, create and delete.
 */
export default function CollectionsScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<Collection[] | null>(null);
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const [renameText, setRenameText] = useState('');
  const [coverPick, setCoverPick] = useState<Collection | null>(null);
  const [coverPosts, setCoverPosts] = useState<{ id: string; thumbnail_url: string }[]>([]);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await getCollections());
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const move = async (index: number, dir: -1 | 1) => {
    if (!rows) return;
    const to = index + dir;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    setRows(next);
    try {
      await reorderCollections(next.map((c) => c.id));
    } catch {
      void load();
    }
  };

  const openCoverPicker = async (c: Collection) => {
    setCoverPick(c);
    try {
      const posts = await getBookmarks(c.id);
      setCoverPosts(posts.map((p) => ({ id: p.id, thumbnail_url: p.thumbnail_url })));
    } catch {
      setCoverPosts([]);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createCollection(name);
      setNewName('');
      void load();
    } catch (e) {
      Alert.alert("Couldn't create", e instanceof Error ? e.message : 'Try again.');
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Collections' }} />
      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.content}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="albums-outline" size={36} color={theme.textSecondary} />
              <ThemedText type="smallBold">Sort your saved posts</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.emptyText}>
                Make collections like “Places to eat” or “Outfit ideas”, then pick one when you
                save a post.
              </ThemedText>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={[styles.row, { borderColor: theme.border }]}>
              {item.cover_url ? (
                <Image source={mediaSource(item.cover_url)} style={styles.cover} contentFit="cover" />
              ) : (
                <View style={[styles.cover, { backgroundColor: theme.backgroundElement }]} />
              )}
              <View style={styles.info}>
                <ThemedText type="smallBold" numberOfLines={1}>
                  {item.name}
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {item.item_count} saved
                </ThemedText>
              </View>
              <Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel={`Move ${item.name} up`} onPress={() => void move(index, -1)}>
                <Ionicons name="chevron-up" size={20} color={index === 0 ? theme.border : theme.text} />
              </Pressable>
              <Pressable hitSlop={8} accessibilityRole="button" accessibilityLabel={`Move ${item.name} down`} onPress={() => void move(index, 1)}>
                <Ionicons name="chevron-down" size={20} color={index === rows.length - 1 ? theme.border : theme.text} />
              </Pressable>
              <Pressable
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Options for ${item.name}`}
                onPress={() =>
                  Alert.alert(item.name, undefined, [
                    {
                      text: 'Rename',
                      onPress: () => {
                        setRenameText(item.name);
                        setRenaming(item);
                      },
                    },
                    { text: 'Choose cover', onPress: () => void openCoverPicker(item) },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: () => {
                        void (async () => {
                          if (!(await confirm('Delete this collection?', 'The posts stay saved in All.', 'Delete'))) return;
                          try {
                            await deleteCollection(item.id);
                            void load();
                          } catch {
                            Alert.alert("Couldn't delete", 'Please try again.');
                          }
                        })();
                      },
                    },
                    { text: 'Cancel', style: 'cancel' },
                  ])
                }>
                <Ionicons name="ellipsis-horizontal" size={20} color={theme.textSecondary} />
              </Pressable>
            </View>
          )}
          ListFooterComponent={
            <View style={styles.footer}>
              <TextField label="New collection" placeholder="Name" value={newName} onChangeText={setNewName} />
              <Button title="Create" variant="secondary" onPress={() => void create()} disabled={!newName.trim()} />
            </View>
          }
        />
      )}

      {renaming ? (
        <View style={[styles.sheet, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <ThemedText type="smallBold">Rename collection</ThemedText>
          <TextField label="" value={renameText} onChangeText={setRenameText} />
          <View style={styles.sheetRow}>
            <Button
              title="Save"
              onPress={async () => {
                try {
                  await renameCollection(renaming.id, renameText);
                  setRenaming(null);
                  void load();
                } catch (e) {
                  Alert.alert("Couldn't rename", e instanceof Error ? e.message : 'Try again.');
                }
              }}
              disabled={!renameText.trim()}
            />
            <Button title="Cancel" variant="secondary" onPress={() => setRenaming(null)} />
          </View>
        </View>
      ) : null}

      <ActionMenu
        visible={!!coverPick && coverPosts.length === 0}
        title="Choose cover"
        options={[{ label: 'Save a post to this collection first', onPress: () => setCoverPick(null) }]}
        onClose={() => setCoverPick(null)}
      />
      {coverPick && coverPosts.length > 0 ? (
        <View style={[styles.sheet, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <ThemedText type="smallBold">Cover for “{coverPick.name}”</ThemedText>
          <View style={styles.coverGrid}>
            {coverPosts.slice(0, 9).map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                onPress={async () => {
                  try {
                    await setCollectionCover(coverPick.id, p.id);
                    setCoverPick(null);
                    void load();
                  } catch {
                    Alert.alert("Couldn't set cover", 'Please try again.');
                  }
                }}>
                <Image source={mediaSource(p.thumbnail_url)} style={styles.coverOption} contentFit="cover" />
              </Pressable>
            ))}
          </View>
          <Button title="Cancel" variant="secondary" onPress={() => setCoverPick(null)} />
        </View>
      ) : null}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 8 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 12 },
  emptyText: { textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 10,
  },
  cover: { width: 44, height: 44, borderRadius: 8 },
  info: { flex: 1, gap: 2 },
  footer: { gap: 8, marginTop: 12 },
  sheet: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  sheetRow: { flexDirection: 'row', gap: 10 },
  coverGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  coverOption: { width: 72, height: 72, borderRadius: 8 },
});
