import { supabase } from '@/lib/supabase';

/**
 * Part 14A: the feed stops being a black box. Interests are the learned
 * user_tags weights in plain words; "not interested" mutes a topic out of
 * the deck for 30/90 days or forever; "show me more" is a gentle capped
 * bump. All weights/caps live in platform_settings server-side.
 */

export type Interest = {
  tag_id: string;
  name: string;
  weight: number;
  level: string; // plain words from the server ("A big interest", …)
  muted: boolean;
  muted_until: string | null;
};

export async function getMyInterests(limit = 20): Promise<Interest[]> {
  const { data, error } = await supabase.rpc('get_my_interests', { _limit: limit });
  if (error) throw error;
  return (data ?? []) as Interest[];
}

/** days: 30, 90 or null (forever). */
export async function muteTopic(tagId: string, days: 30 | 90 | null): Promise<void> {
  const { error } = await supabase.rpc('mute_topic', { _tag_id: tagId, _days: days });
  if (error) throw error;
}

/** Resolve a tag NAME (deck cards carry names, not ids) and mute it. */
export async function muteTopicByName(name: string, days: 30 | 90 | null): Promise<void> {
  const { data, error } = await supabase.from('tags').select('id').eq('name', name).maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error('Topic not found');
  await muteTopic(data.id as string, days);
}

export async function unmuteTopic(tagId: string): Promise<void> {
  const { error } = await supabase.rpc('unmute_topic', { _tag_id: tagId });
  if (error) throw error;
}

export async function showMoreLikeThis(postId: string): Promise<void> {
  const { error } = await supabase.rpc('show_more_like_this', { _post_id: postId });
  if (error) throw error;
}

export async function removeInterest(tagId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_interest', { _tag_id: tagId });
  if (error) throw error;
}
