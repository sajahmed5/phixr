import { supabase } from '@/lib/supabase';

/** Part 12C/12D/12E client helpers: pins, highlights, links, category,
 *  collab, pinned comments, hidden words, quick replies, DM folders. */

// --- Pinned posts ---------------------------------------------------------
export async function setPostPinned(postId: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_post_pinned', { _post_id: postId, _pinned: pinned });
  if (error) throw new Error(error.message);
}

// --- Story highlights -----------------------------------------------------
export type Highlight = { id: string; name: string; cover_url: string | null; position: number; item_count: number };
export type HighlightItem = {
  media_url: string; thumbnail_url: string | null; media_type: string;
  overlay_text: string | null; position: number; added_at: string;
};

export async function getHighlights(userId: string): Promise<Highlight[]> {
  const { data, error } = await supabase.rpc('get_highlights', { _user_id: userId });
  if (error) throw new Error(error.message);
  return (data ?? []) as Highlight[];
}

export async function getHighlightItems(highlightId: string): Promise<HighlightItem[]> {
  const { data, error } = await supabase.rpc('get_highlight_items', { _highlight_id: highlightId });
  if (error) throw new Error(error.message);
  return (data ?? []) as HighlightItem[];
}

export async function createHighlight(name: string): Promise<string> {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('story_highlights')
    .insert({ user_id: u.user!.id, name: name.trim() })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

export async function deleteHighlight(id: string): Promise<void> {
  const { error } = await supabase.from('story_highlights').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function addStoryToHighlight(highlightId: string, storyId: string): Promise<void> {
  const { error } = await supabase.rpc('add_story_to_highlight', {
    _highlight_id: highlightId,
    _story_id: storyId,
  });
  if (error) throw new Error(error.message);
}

// --- Link in bio ----------------------------------------------------------
export type ProfileLink = { id: string; title: string; url: string; position: number; tap_count: number };

export async function getProfileLinks(userId: string): Promise<ProfileLink[]> {
  const { data, error } = await supabase
    .from('profile_links')
    .select('id, title, url, position, tap_count')
    .eq('user_id', userId)
    .order('position');
  if (error) throw new Error(error.message);
  return (data ?? []) as ProfileLink[];
}

export async function addProfileLink(title: string, url: string): Promise<void> {
  const { error } = await supabase.rpc('add_profile_link', { _title: title, _url: url });
  if (error) throw new Error(error.message);
}

export async function removeProfileLink(id: string): Promise<void> {
  const { error } = await supabase.from('profile_links').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export function recordLinkTap(id: string): void {
  void supabase.rpc('record_link_tap', { _link_id: id });
}

export async function setProfileCategory(category: string | null): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('profiles')
    .update({ category: category?.trim() || null })
    .eq('id', u.user!.id);
  if (error) throw new Error(error.message);
}

// --- Collab posts ---------------------------------------------------------
export type Collaborator = {
  post_id: string; user_id: string; status: string;
  handle?: string; display_name?: string;
};

export async function inviteCollaborator(postId: string, handle: string): Promise<void> {
  const { error } = await supabase.rpc('invite_collaborator', { _post_id: postId, _handle: handle });
  if (error) throw new Error(error.message);
}

export async function respondCollab(postId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_collab', { _post_id: postId, _accept: accept });
  if (error) throw new Error(error.message);
}

export async function leaveCollab(postId: string): Promise<void> {
  const { error } = await supabase.rpc('leave_collab', { _post_id: postId });
  if (error) throw new Error(error.message);
}

/** Accepted co-authors of a post (public), plus my own pending invite if any. */
export async function getCollaborators(postId: string): Promise<Collaborator[]> {
  const { data, error } = await supabase
    .from('post_collaborators')
    .select('post_id, user_id, status, profiles!post_collaborators_user_id_fkey(handle, display_name)')
    .eq('post_id', postId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as (Collaborator & { profiles: { handle: string; display_name: string } | null })[])
    .map((r) => ({ ...r, handle: r.profiles?.handle, display_name: r.profiles?.display_name }));
}

/** Post ids where this user is an ACCEPTED co-author (for profile grids). */
export async function collabPostIds(userId: string): Promise<string[]> {
  const { data } = await supabase
    .from('post_collaborators')
    .select('post_id')
    .eq('user_id', userId)
    .eq('status', 'accepted');
  return ((data ?? []) as { post_id: string }[]).map((r) => r.post_id);
}

// --- Pinned comments ------------------------------------------------------
export async function pinComment(commentId: string, pinned: boolean): Promise<void> {
  const { error } = await supabase.rpc('pin_comment', { _comment_id: commentId, _pinned: pinned });
  if (error) throw new Error(error.message);
}

// --- Hidden words ---------------------------------------------------------
export async function getHiddenWords(): Promise<string[]> {
  const { data: u } = await supabase.auth.getUser();
  const { data } = await supabase
    .from('user_hidden_words')
    .select('phrase')
    .eq('user_id', u.user!.id)
    .order('phrase');
  return ((data ?? []) as { phrase: string }[]).map((r) => r.phrase);
}

export async function addHiddenWord(phrase: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('user_hidden_words')
    .insert({ user_id: u.user!.id, phrase: phrase.trim().toLowerCase() });
  if (error && !error.message.includes('duplicate')) throw new Error(error.message);
}

export async function removeHiddenWord(phrase: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  await supabase.from('user_hidden_words').delete().eq('user_id', u.user!.id).eq('phrase', phrase);
}

export async function setUseDefaultHiddenWords(on: boolean): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('profiles')
    .update({ use_default_hidden_words: on })
    .eq('id', u.user!.id);
  if (error) throw new Error(error.message);
}

export async function setCommentLimit(limit: 'followers' | 'week_followers' | null): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('profiles')
    .update({ comment_limit: limit })
    .eq('id', u.user!.id);
  if (error) throw new Error(error.message);
}

// --- Quick replies --------------------------------------------------------
export type QuickReply = { id: string; shortcut: string; body: string; position: number };

export async function getQuickReplies(): Promise<QuickReply[]> {
  const { data: u } = await supabase.auth.getUser();
  const { data } = await supabase
    .from('quick_replies')
    .select('id, shortcut, body, position')
    .eq('user_id', u.user!.id)
    .order('position');
  return (data ?? []) as QuickReply[];
}

export async function saveQuickReply(shortcut: string, body: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('quick_replies')
    .upsert({ user_id: u.user!.id, shortcut: shortcut.trim(), body: body.trim() },
            { onConflict: 'user_id,shortcut' });
  if (error) throw new Error(error.message);
}

export async function deleteQuickReply(id: string): Promise<void> {
  await supabase.from('quick_replies').delete().eq('id', id);
}

// --- DM folders -----------------------------------------------------------
export async function setConversationFolder(cid: string, folder: 'primary' | 'general'): Promise<void> {
  const { error } = await supabase.rpc('set_conversation_folder', { _cid: cid, _folder: folder });
  if (error) throw new Error(error.message);
}

export async function getMyFolders(): Promise<Map<string, string>> {
  const { data: u } = await supabase.auth.getUser();
  const { data } = await supabase
    .from('conversation_members')
    .select('conversation_id, folder')
    .eq('user_id', u.user!.id);
  return new Map(((data ?? []) as { conversation_id: string; folder: string }[])
    .map((r) => [r.conversation_id, r.folder]));
}
