import { supabase } from '@/lib/supabase';
import type { PipelineResult } from '@/lib/upload';

/**
 * Part 12A/12B: server-synced drafts + the scheduler.
 *
 * A draft stores the composition payload with PIPELINE-PROCESSED media keys
 * (so its moderation verdict is already known and publishing is instant and
 * pre-checked). Autosave uses one rolling slot per kind. Scheduling runs
 * through schedule_draft (limits + pre-publish text moderation server-side);
 * a pg_cron job publishes due drafts within a minute.
 */

export type DraftMedia = {
  media_url: string;
  thumbnail_url: string;
  media_type: 'image' | 'video';
  moderation_status?: string;
};

export type DraftPayload = {
  caption: string;
  alt_text: string;
  visibility: 'public' | 'private' | 'groups';
  group_ids: string[];
  tags: { name: string; source: 'user' | 'vision' | 'geo' }[];
  attach_location: boolean;
  location_cell: string | null;
  location_label?: string | null;
  partner_brand?: string | null;
  overlays?: unknown[];
  audience?: 'default' | 'groups'; // stories
  media: DraftMedia[];
};

export type Draft = {
  id: string;
  kind: 'post' | 'story';
  payload: DraftPayload;
  media_status: 'approved' | 'flagged' | 'pending' | 'removed';
  status: 'draft' | 'scheduled' | 'held' | 'publishing' | 'published' | 'failed';
  scheduled_at: string | null;
  failure_reason: string | null;
  autosave: boolean;
  updated_at: string;
};

export function mediaFromPipeline(results: PipelineResult[]): DraftMedia[] {
  return results.map((r) => ({
    media_url: r.media_url,
    thumbnail_url: r.thumbnail_url,
    media_type: r.media_type,
    moderation_status: r.moderation_status,
  }));
}

function worstStatus(media: DraftMedia[]): Draft['media_status'] {
  const order = ['approved', 'pending', 'flagged', 'removed'];
  let worst = 'approved';
  for (const m of media) {
    const s = m.moderation_status ?? 'pending';
    if (order.indexOf(s) > order.indexOf(worst)) worst = s;
  }
  return worst as Draft['media_status'];
}

/** Create or update a draft. Pass `id` to update; `autosave` for the slot. */
export async function saveDraft(
  kind: 'post' | 'story',
  payload: DraftPayload,
  opts: { id?: string; autosave?: boolean } = {},
): Promise<string> {
  const { data: u } = await supabase.auth.getUser();
  const row = {
    user_id: u.user!.id,
    kind,
    payload,
    media_status: worstStatus(payload.media),
    autosave: opts.autosave ?? false,
  };
  if (opts.id) {
    const { error } = await supabase.from('post_drafts').update(row).eq('id', opts.id);
    if (error) throw error;
    return opts.id;
  }
  if (opts.autosave) {
    // One rolling autosave slot per kind: replace it.
    const { data: existing } = await supabase
      .from('post_drafts')
      .select('id')
      .eq('user_id', u.user!.id)
      .eq('kind', kind)
      .eq('autosave', true)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase.from('post_drafts').update(row).eq('id', existing.id);
      if (error) throw error;
      return existing.id;
    }
  }
  const { data, error } = await supabase.from('post_drafts').insert(row).select('id').single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function listDrafts(): Promise<Draft[]> {
  const { data, error } = await supabase
    .from('post_drafts')
    .select('id, kind, payload, media_status, status, scheduled_at, failure_reason, autosave, updated_at')
    // Practice posts from test-mode Publishing API apps never show in the app.
    .eq('api_test', false)
    .neq('status', 'published')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Draft[];
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await supabase.from('post_drafts').delete().eq('id', id);
  if (error) throw error;
}

export async function scheduleDraft(id: string, when: Date): Promise<void> {
  const { error } = await supabase.rpc('schedule_draft', {
    _draft_id: id,
    _when: when.toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function cancelSchedule(id: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_schedule', { _draft_id: id });
  if (error) throw new Error(error.message);
}

/** "Post now" for a scheduled/held/failed draft: reschedule to now. */
export async function postNow(id: string): Promise<void> {
  await scheduleDraft(id, new Date());
}

/** Scheduled + held + failed rows for the content calendar. */
export async function listScheduled(): Promise<Draft[]> {
  const { data, error } = await supabase
    .from('post_drafts')
    .select('id, kind, payload, media_status, status, scheduled_at, failure_reason, autosave, updated_at')
    // Practice posts from test-mode Publishing API apps never show in the app.
    .eq('api_test', false)
    .in('status', ['scheduled', 'held', 'failed', 'publishing'])
    .order('scheduled_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Draft[];
}
