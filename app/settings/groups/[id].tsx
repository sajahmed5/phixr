import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, SectionList, StyleSheet, View } from 'react-native';

import { UserRow } from '@/components/profile/user-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import {
  addGroupMember,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  renameGroup,
  type GroupMember,
} from '@/lib/groups';
import { getConnections, type Connection } from '@/lib/profile';

/**
 * One group's roster (owner-only). Adding is limited to accepted followers;
 * removing someone ends their access to the group's past posts immediately.
 * Members are never notified either way.
 */
export default function GroupMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [name, setName] = useState<string>('');
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [followers, setFollowers] = useState<Connection[] | null>(null);

  const load = useCallback(async () => {
    try {
      const [gs, ms, fs] = await Promise.all([
        listGroups(),
        listGroupMembers(id),
        user?.id ? getConnections(user.id, 'followers') : Promise.resolve([]),
      ]);
      setName(gs.find((g) => g.id === id)?.name ?? '');
      setMembers(ms);
      setFollowers(fs);
    } catch {
      setMembers([]);
      setFollowers([]);
    }
  }, [id, user?.id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const addable = useMemo(
    () => (followers ?? []).filter((f) => !(members ?? []).some((m) => m.member_id === f.id)),
    [followers, members],
  );

  const add = async (f: Connection) => {
    setMembers((prev) =>
      prev
        ? [
            { member_id: f.id, handle: f.handle, display_name: f.display_name, avatar_url: f.avatar_url },
            ...prev,
          ]
        : prev,
    );
    try {
      await addGroupMember(id, f.id);
    } catch {
      void load();
    }
  };
  const remove = async (m: GroupMember) => {
    setMembers((prev) => prev?.filter((x) => x.member_id !== m.member_id) ?? prev);
    try {
      await removeGroupMember(id, m.member_id);
    } catch {
      void load();
    }
  };

  const rename = () => {
    Alert.prompt?.(
      'Rename group',
      undefined,
      async (newName?: string) => {
        const clean = (newName ?? '').trim();
        if (!clean) return;
        try {
          await renameGroup(id, clean);
          setName(clean);
        } catch {
          Alert.alert("Couldn't rename", 'Group names must be unique.');
        }
      },
      'plain-text',
      name,
    );
  };

  type Row = {
    key: string;
    handle: string;
    display_name: string;
    avatar_url: string | null;
    kind: 'member' | 'follower';
  };
  const sections: { title: string; kind: 'member' | 'follower'; data: Row[] }[] = [
    {
      title: `In this group (${members?.length ?? 0})`,
      kind: 'member',
      data: (members ?? []).map((m) => ({
        key: m.member_id,
        handle: m.handle,
        display_name: m.display_name,
        avatar_url: m.avatar_url,
        kind: 'member' as const,
      })),
    },
    {
      title: 'Add followers',
      kind: 'follower',
      data: addable.map((f) => ({
        key: f.id,
        handle: f.handle,
        display_name: f.display_name,
        avatar_url: f.avatar_url,
        kind: 'follower' as const,
      })),
    },
  ];

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: name || 'Group',
          headerRight: () => <Button title="Rename" variant="secondary" onPress={rename} />,
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.content}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <ThemedText type="smallBold">{section.title}</ThemedText>
            {section.kind === 'member' && section.data.length === 0 ? (
              <ThemedText type="small" themeColor="textSecondary">
                Nobody yet — add followers below. They won&apos;t be told.
              </ThemedText>
            ) : null}
          </View>
        )}
        renderItem={({ item }) => (
          <UserRow
            handle={item.handle}
            displayName={item.display_name}
            avatarUrl={item.avatar_url}
            right={
              item.kind === 'member' ? (
                <Button
                  title="Remove"
                  variant="secondary"
                  onPress={() =>
                    void remove({
                      member_id: item.key,
                      handle: item.handle,
                      display_name: item.display_name,
                      avatar_url: item.avatar_url,
                    })
                  }
                />
              ) : (
                <Button
                  title="Add"
                  onPress={() =>
                    void add({
                      id: item.key,
                      handle: item.handle,
                      display_name: item.display_name,
                      avatar_url: item.avatar_url,
                    })
                  }
                />
              )
            }
          />
        )}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 4 },
  sectionHeader: { marginTop: 12, marginBottom: 6, gap: 4 },
});
