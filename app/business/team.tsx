import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import {
  inviteTeamMember,
  listTeam,
  removeTeamMember,
  TEAM_ROLE_BLURB,
  type TeamMember,
  type TeamRole,
} from '@/lib/business';
import { confirm } from '@/lib/confirm';

/**
 * Part 13A: the business team. Members use their OWN Phixr logins; every
 * ads-manager action they take is written to the activity log by the server.
 * Removal takes effect immediately.
 */

const ROLES: TeamRole[] = ['admin', 'editor', 'analyst', 'moderator'];
const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

export default function BusinessTeamScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ business?: string }>();
  const businessId = (typeof params.business === 'string' && params.business) || user?.id || '';

  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState<TeamRole>('editor');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTeam(await listTeam(businessId));
    } catch {
      setTeam([]);
    }
  }, [businessId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount data-loader
    void load();
  }, [load]);

  const invite = async () => {
    const target = who.trim();
    if (!target) return;
    setBusy(true);
    try {
      await inviteTeamMember(businessId, target, role);
      setWho('');
      void load();
    } catch (e) {
      Alert.alert("Couldn't invite", e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: TeamMember) => {
    const name = m.profiles?.handle ? `@${m.profiles.handle}` : 'this member';
    if (!(await confirm('Remove from team?', `${name} loses access immediately.`, 'Remove'))) return;
    try {
      await removeTeamMember(businessId, m.member_id);
      void load();
    } catch (e) {
      Alert.alert("Couldn't remove", e instanceof Error ? e.message : 'Please try again.');
    }
  };

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: 'Team' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedText type="small" themeColor="textSecondary">
          Your team signs in with their own accounts — never share your password. Everything
          they do in the ads manager and inbox is recorded in the activity log.
        </ThemedText>

        {team === null ? <ActivityIndicator color={theme.textSecondary} /> : null}
        {team?.length === 0 ? (
          <ThemedText type="small" themeColor="textSecondary">
            No team members yet.
          </ThemedText>
        ) : null}
        {(team ?? []).map((m) => (
          <View key={m.member_id} style={[styles.row, { borderColor: theme.border }]}>
            <View style={styles.info}>
              <ThemedText type="smallBold" numberOfLines={1}>
                {m.profiles?.handle ? `@${m.profiles.handle}` : 'Member'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {roleLabel(m.role)}
                {m.status === 'pending' ? ' · invite pending' : ''}
              </ThemedText>
            </View>
            <Button title="Remove" variant="secondary" onPress={() => void remove(m)} />
          </View>
        ))}

        <ThemedText type="smallBold" style={styles.subhead}>Invite someone</ThemedText>
        <TextField
          label="Handle or email"
          placeholder="@handle or name@example.com"
          value={who}
          onChangeText={setWho}
          autoCapitalize="none"
        />
        <View style={styles.roles}>
          {ROLES.map((r) => (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityLabel={`Role ${r}`}
              onPress={() => setRole(r)}
              style={[
                styles.roleChip,
                { borderColor: role === r ? BRAND.accent : theme.border },
                role === r ? styles.roleChipOn : null,
              ]}>
              <ThemedText type="smallBold">{roleLabel(r)}</ThemedText>
            </Pressable>
          ))}
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          {TEAM_ROLE_BLURB[role]}. Team members must be over 18.
        </ThemedText>
        <Button
          title={busy ? 'Inviting…' : 'Send invite'}
          onPress={() => void invite()}
          disabled={busy || !who.trim()}
        />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, gap: 10, paddingBottom: 48 },
  subhead: { marginTop: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  info: { flex: 1, gap: 2 },
  roles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roleChip: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roleChipOn: { backgroundColor: 'rgba(255, 122, 24, 0.12)' },
});
