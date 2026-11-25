import { supabase } from '@/lib/supabase';

/**
 * Fire-and-forget point awards for actions that aren't already awarded server-side
 * (swipes/comments go through their own RPCs). Every reason is capped server-side
 * (daily ceiling + per-reason caps), so extra calls are harmless — never block the UI
 * on these or surface errors.
 */
export function awardShare(postId: string): void {
  void supabase.rpc('award_share', { _post_id: postId }).then(
    () => {},
    () => {},
  );
}

/** Award for starting/participating in a conversation (capped ~5/day server-side). */
export function awardMessageActivity(conversationId: string): void {
  void supabase.rpc('award_message_activity', { _conversation_id: conversationId }).then(
    () => {},
    () => {},
  );
}

/** One row of the caller's own earn/spend history (Part 5A). */
export type PointsHistoryRow = {
  reason: string;
  delta: number;
  ref_type: string | null;
  created_at: string;
};

/** Plain-English labels for ledger reasons (settings drive the values, so no numbers here). */
export const POINTS_REASON_LABELS: Record<string, string> = {
  swipe: 'Swiping the deck',
  comment: 'Commenting',
  comment_reply: 'Replying to a comment',
  comment_reaction: 'Reacting to a comment',
  share: 'Sharing a post',
  message_new: 'Starting a conversation',
  message_reply: 'Replying to a DM',
  active_day: 'Active today',
  like_milestone: 'Your post got likes',
  reach_milestone: 'Reach milestone',
  boost_purchase: 'Boost purchased',
  boost_refund: 'Boost refund',
  undo: 'Swipe undone',
};

/** The caller's points history, newest first (owner-only server-side). */
export async function getPointsHistory(
  before: string | null = null,
  limit = 50,
): Promise<PointsHistoryRow[]> {
  const { data, error } = await supabase.rpc('get_points_history', {
    _before: before,
    _limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as PointsHistoryRow[];
}

/** Award the once-per-day "active day" bonus. Safe to call on every app open. */
export function awardActiveDay(): void {
  void supabase.rpc('award_active_day').then(
    () => {},
    () => {},
  );
}
