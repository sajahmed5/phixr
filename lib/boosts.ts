import { supabase } from '@/lib/supabase';

/**
 * Boosts (Part 5B, points-paid phase). One system for everyone: a boost shows
 * a public post more often in the deck to a chosen adult audience for a set
 * time, always labelled "Boosted". Money payments (Apple/Google IAP) arrive
 * in a later native build — the server already carries the payment fields.
 */

export type BoostEstimate = { audience_size: number; est_daily_views: number };

export type MyBoost = {
  id: string;
  post_id: string;
  status: 'active' | 'ended' | 'cancelled';
  starts_at: string;
  ends_at: string;
  days: number;
  points_cost: number;
  age_bands: string[];
  region_label: string | null;
  served_impressions: number;
  window_views: number;
  window_likes: number;
  points_per_like: number | null;
  thumbnail_url: string;
  media_type: 'image' | 'video';
  caption: string | null;
};

export const ADULT_BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'] as const;

/** Labelled estimate shown BEFORE confirming — matching adults + a rough daily figure. */
export async function estimateBoostReach(
  ageBands: string[],
  regionLabel: string | null,
  tagIds: string[],
): Promise<BoostEstimate> {
  const { data, error } = await supabase.rpc('estimate_boost_reach', {
    _age_bands: ageBands,
    _region_label: regionLabel,
    _tag_ids: tagIds,
  });
  if (error) throw error;
  return (data?.[0] ?? { audience_size: 0, est_daily_views: 0 }) as BoostEstimate;
}

/** Buy a boost with points. The server enforces every rule (adult owner,
 *  public approved post, one active boost per post, balance). */
export async function createBoost(
  postId: string,
  days: number,
  ageBands: string[],
  regionLabel: string | null,
  tagIds: string[],
): Promise<string> {
  const { data, error } = await supabase.rpc('create_boost', {
    _post_id: postId,
    _days: days,
    _age_bands: ageBands,
    _region_label: regionLabel,
    _tag_ids: tagIds,
  });
  if (error) throw error;
  return data as string;
}

/** Stop a running boost; unused whole days are refunded in points. */
export async function cancelBoost(boostId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_boost', { _boost_id: boostId });
  if (error) throw error;
}

/** The caller's boosts with window results (views, likes, points per like). */
export async function getMyBoosts(limit = 20): Promise<MyBoost[]> {
  const { data, error } = await supabase.rpc('get_my_boosts', { _limit: limit });
  if (error) throw error;
  return (data ?? []) as MyBoost[];
}
