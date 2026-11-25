import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useTheme } from '@/hooks/use-theme';
import { createGroup, deleteGroup, listGroups, type AudienceGroup } from '@/lib/groups';

/**
 * Audience groups (Part 4A). Only the owner ever sees this — group names and
 * membership are secret from everyone else, including the members.
 */
export default function GroupsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [groups, setGroups] = useState<AudienceGroup[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGroups(await listGroups());
    } catch {
      setGroups([]);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const add = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await createGroup(clean);
      setName('');
      await load();
    } catch {
      Alert.alert("Couldn't create the group", 'Group names must be unique.');
    } finally {
      setBusy(false);
    }
  };

  const remove = (g: AudienceGroup) => {
    // The brief's question, asked straight: what happens to this group's posts?
    Alert.alert(
      `Delete "${g.name}"?`,
      'What should happen to posts and stories that were shared ONLY with this group?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Make them followers-only',
          onPress: () => void doDelete(g.id, 'followers'),
        },
        {
          text: 'Delete them too',
          style: 'destructive',
          onPress: () => void doDelete(g.id, 'delete'),
        },
      ],
    );
  };
  const doDelete = async (id: string, mode: 'followers' | 'delete') => {
    try {
      await deleteGroup(id, mode);
      await load();
    } catch {
      Alert.alert("Couldn't delete the group", 'Please try again.');
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Audience groups' }} />
      <FlatList
        data={groups ?? []}
        keyExtractor={(g) => g.id}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            <ThemedText type="small" themeColor="textSecondary">
              Share posts and stories with just the people you choose. Nobody is ever told
              they&apos;re in a group — no badge, no notification.
            </ThemedText>
            <View style={styles.addRow}>
              <View style={styles.addField}>
                <TextField
                  label="New group"
                  placeholder="Friends, Family, Work…"
                  value={name}
                  maxLength={40}
                  onChangeText={setName}
                />
              </View>
              <Button title="Create" onPress={add} disabled={!name.trim() || busy} />
            </View>
          </View>
        }
        ListEmptyComponent={
          groups === null ? null : (
            <ThemedText type="small" themeColor="textSecondary" style={styles.empty}>
              No groups yet.
            </ThemedText>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push(`/settings/groups/${item.id}`)}
            style={[styles.row, { borderColor: theme.border }]}>
            <View style={styles.rowText}>
              <ThemedText type="smallBold">{item.name}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {item.member_count === 1 ? '1 person' : `${item.member_count ?? 0} people`}
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${item.name}`}
              hitSlop={8}
              onPress={() => remove(item)}>
              <Ionicons name="trash-outline" size={20} color={theme.textSecondary} />
            </Pressable>
            <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
          </Pressable>
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 10 },
  header: { gap: 12, marginBottom: 8 },
  addRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  addField: { flex: 1 },
  empty: { textAlign: 'center', marginTop: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
  },
  rowText: { flex: 1, gap: 2 },
});
