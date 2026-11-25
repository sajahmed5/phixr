import { supabase } from '@/lib/supabase';

/**
 * Private audience groups (Part 4A). All reads/writes ride the owner-only RLS
 * policies — a member can never see a group row, so nothing here ever reveals
 * membership to anyone but the owner.
 */

export type AudienceGroup = {
  id: string;
  name: string;
  created_at: string;
  /** Owner-side convenience count; never shown to anyone else. */
  member_count?: number;
};

export type GroupMember = {
  member_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
};

export async function listGroups(): Promise<AudienceGroup[]> {
  const { data, error } = await supabase
    .from('audience_groups')
    .select('id, name, created_at, audience_group_members(count)')
    .order('name');
  if (error) throw error;
  type Row = AudienceGroup & { audience_group_members: { count: number }[] };
  return ((data ?? []) as Row[]).map((g) => ({
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    member_count: g.audience_group_members?.[0]?.count ?? 0,
  }));
}

export async function createGroup(name: string): Promise<AudienceGroup> {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('audience_groups')
    .insert({ name: name.trim(), owner_id: u.user!.id })
    .select('id, name, created_at')
    .single();
  if (error) throw error;
  return data as AudienceGroup;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const { error } = await supabase
    .from('audience_groups')
    .update({ name: name.trim() })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Delete a group. `mode` decides what happens to posts/stories whose ONLY
 * audience was this group: 'followers' makes them followers-only, 'delete'
 * removes them. Content shared with other groups too just loses this one.
 */
export async function deleteGroup(id: string, mode: 'followers' | 'delete'): Promise<void> {
  const { error } = await supabase.rpc('delete_audience_group', {
    _group_id: id,
    _mode: mode,
  });
  if (error) throw error;
}

export async function listGroupMembers(groupId: string): Promise<GroupMember[]> {
  const { data, error } = await supabase
    .from('audience_group_members')
    .select('member_id, profiles:member_id (handle, display_name, avatar_url)')
    .eq('group_id', groupId)
    .order('added_at', { ascending: false });
  if (error) throw error;
  type Row = {
    member_id: string;
    profiles: { handle: string; display_name: string; avatar_url: string | null } | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    member_id: r.member_id,
    handle: r.profiles?.handle ?? '',
    display_name: r.profiles?.display_name ?? '',
    avatar_url: r.profiles?.avatar_url ?? null,
  }));
}

/** Add an accepted follower to a group (RLS rejects anyone else). */
export async function addGroupMember(groupId: string, memberId: string): Promise<void> {
  const { error } = await supabase
    .from('audience_group_members')
    .insert({ group_id: groupId, member_id: memberId });
  if (error && error.code !== '23505') throw error; // already a member is fine
}

/** Remove a member — their access to the group's past posts ends immediately. */
export async function removeGroupMember(groupId: string, memberId: string): Promise<void> {
  const { error } = await supabase
    .from('audience_group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('member_id', memberId);
  if (error) throw error;
}

/** Attach a 'groups' post's audience. Call right after inserting the post. */
export async function setPostGroups(postId: string, groupIds: string[]): Promise<void> {
  if (groupIds.length === 0) return;
  const { error } = await supabase
    .from('post_audience_groups')
    .insert(groupIds.map((g) => ({ post_id: postId, group_id: g })));
  if (error) throw error;
}
