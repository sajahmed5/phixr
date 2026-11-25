import { supabase } from '@/lib/supabase';

/**
 * Part 9A/9B: paid partnerships. The label is ASA disclosure: it shows from
 * the moment the creator declares it and can never be removed by the creator
 * (server-enforced — there are no client write paths on the table). The
 * brand's name only joins the label once the brand approves.
 */

export type PartnershipStatus = 'pending' | 'approved' | 'declined' | 'revoked';

export type MyPartnership = {
  post_id: string;
  creator_id: string;
  brand_id: string;
  status: PartnershipStatus;
  created_at: string;
};

/** Declare at (or after) posting. Server refuses minors and non-business brands. */
export async function declarePartnership(postId: string, brandHandle: string): Promise<void> {
  const { error } = await supabase.rpc('declare_partnership', {
    _post_id: postId,
    _brand_handle: brandHandle,
  });
  if (error) throw new Error(error.message);
}

export async function respondPartnership(postId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_partnership', {
    _post_id: postId,
    _accept: accept,
  });
  if (error) throw new Error(error.message);
}

export async function revokePartnership(postId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_partnership', { _post_id: postId });
  if (error) throw new Error(error.message);
}

/** Public labels for a batch of posts (deck page, feed, post screen). */
export async function getPartnershipLabels(postIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (postIds.length === 0) return map;
  const { data } = await supabase.rpc('get_post_partnerships', { _post_ids: postIds });
  for (const row of (data ?? []) as { post_id: string; label: string }[]) {
    map.set(row.post_id, row.label);
  }
  return map;
}

/** Attach partner_label to a deck/feed batch (best-effort: labels also show
 *  on the post page, so a transient failure here is not fatal). */
export async function attachPartnershipLabels<T extends { id: string }>(
  batch: T[],
): Promise<(T & { partner_label?: string })[]> {
  try {
    const labels = await getPartnershipLabels(batch.map((c) => c.id));
    if (labels.size === 0) return batch;
    return batch.map((c) => {
      const label = labels.get(c.id);
      return label ? { ...c, partner_label: label } : c;
    });
  } catch {
    return batch;
  }
}

/** The brand's queue: partnerships where I am the tagged business. */
export async function getBrandPartnerships(): Promise<
  (MyPartnership & { creator_handle: string; caption: string | null })[]
> {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('post_partnerships')
    .select('post_id, creator_id, brand_id, status, created_at, profiles!post_partnerships_creator_id_fkey(handle), posts(caption)')
    .eq('brand_id', u.user?.id ?? '')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as (MyPartnership & {
    profiles: { handle: string } | null;
    posts: { caption: string | null } | null;
  })[]).map((r) => ({
    ...r,
    creator_handle: r.profiles?.handle ?? 'unknown',
    caption: r.posts?.caption ?? null,
  }));
}

/** Anonymous performance data for an APPROVED partnership (brand side). */
export async function getPartnerPostStats(postId: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('get_partner_post_stats', { _post_id: postId });
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}

// --- Promotional-post prompt (9C) -----------------------------------------

let hintCache: RegExp[] | null = null;

/** Settings-driven "this looks promotional" patterns, compiled once. */
export async function getPromoHintPatterns(): Promise<RegExp[]> {
  if (hintCache) return hintCache;
  const { data } = await supabase.rpc('get_promo_hints');
  hintCache = ((data ?? []) as string[])
    .map((p) => {
      try {
        return new RegExp(p.replace(/\\m/g, '\\b').replace(/\\M/g, '\\b'), 'i');
      } catch {
        return null;
      }
    })
    .filter((r): r is RegExp => r !== null);
  return hintCache;
}

/** Which of these handles are business accounts (the badge is public info). */
export async function businessHandles(handles: string[]): Promise<Set<string>> {
  if (handles.length === 0) return new Set();
  const { data } = await supabase.rpc('business_handles', { _handles: handles.slice(0, 20) });
  return new Set(((data ?? []) as string[]).map((h) => h.toLowerCase()));
}

/** True when the caption looks promotional: promo wording, or an @mention of a business. */
export async function looksPromotional(caption: string): Promise<boolean> {
  if (!caption.trim()) return false;
  const hints = await getPromoHintPatterns();
  if (hints.some((r) => r.test(caption))) return true;
  const mentions = [...caption.matchAll(/@([a-z0-9_]{2,30})/gi)].map((m) => m[1]);
  if (mentions.length === 0) return false;
  const biz = await businessHandles(mentions);
  return biz.size > 0;
}
