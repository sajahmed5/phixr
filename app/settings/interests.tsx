import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ActionMenu } from '@/components/ui/action-menu';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { getMyInterests, muteTopic, removeInterest, unmuteTopic, type Interest } from '@/lib/interests';

/**
 * Part 14A: "Your interests" — what the feed has learned, in plain words,
 * and the controls to change it. No black box: every topic can be muted
 * (30/90 days or forever) or removed outright.
 */
export default function InterestsScreen() {
  const theme = useTheme();
  const [rows, setRows] = useState<Interest[] | null>(null);
  const [acting, setActing] = useState<Interest | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await getMyInterests(30));
    } catch {
      setRows([]);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const mute = async (tagId: string, days: 30 | 90 | null) => {
    setActing(null);
    try {
      await muteTopic(tagId, days);
      void load();
    } catch {
      Alert.alert("Couldn't do that", 'Please try again.');
    }
  };
  const unmute = async (tagId: string) => {
    setActing(null);
    try {
      await unmuteTopic(tagId);
      void load();
    } catch {
      Alert.alert("Couldn't do that", 'Please try again.');
    }
  };
  const remove = async (tagId: string) => {
    setActing(null);
    try {
      await removeInterest(tagId);
      void load();
    } catch {
      Alert.alert("Couldn't do that", 'Please try again.');
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Your interests' }} />
      {rows === null ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.textSecondary} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.centerText}>
            Nothing learned yet — your interests build up as you swipe.
          </ThemedText>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.tag_id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
              Your feed is built from these — learned from what you like and skip. Mute a
              topic to see none of it for a while, or remove it to start fresh.
            </ThemedText>
          }
          renderItem={({ item }) => (
            <View style={[styles.row, { borderColor: theme.border }]}>
              <View style={styles.info}>
                <ThemedText type="smallBold">#{item.name}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {item.muted
                    ? item.muted_until
                      ? `Muted until ${new Date(item.muted_until).toLocaleDateString()}`
                      : 'Muted'
                    : item.level}
                </ThemedText>
              </View>
              <Button
                title={item.muted ? 'Unmute' : 'Change'}
                variant="secondary"
                onPress={() => (item.muted ? void unmute(item.tag_id) : setActing(item))}
              />
            </View>
          )}
        />
      )}
      <ActionMenu
        visible={!!acting}
        title={acting ? `#${acting.name}` : undefined}
        options={
          acting
            ? [
                { label: 'Mute for 30 days', onPress: () => void mute(acting.tag_id, 30) },
                { label: 'Mute for 90 days', onPress: () => void mute(acting.tag_id, 90) },
                { label: 'Mute forever', onPress: () => void mute(acting.tag_id, null) },
                { label: 'Remove this interest', destructive: true, onPress: () => void remove(acting.tag_id) },
              ]
            : []
        }
        onClose={() => setActing(null)}
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerText: { textAlign: 'center' },
  content: { padding: 16, gap: 8 },
  intro: { marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  info: { flex: 1, gap: 2 },
});
