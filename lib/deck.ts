import { signMediaPaths } from '@/lib/media';
import { supabase } from '@/lib/supabase';

/** A card returned by the `get_deck` RPC. */
export type DeckCard = {
  id: string;
  user_id: string;
  media_url: string;
  thumbnail_url: string;
  media_type: 'image' | 'video';
  caption: string | null;
  alt_text: string | null;
  like_count: number;
  skip_count: number;
  comment_count: number;
  created_at: string;
  poster_handle: string;
  poster_display_name: string;
  poster_avatar_url: string | null;
  tags: string[];
  /** Friends-feed heart likes (separate from deck like_count by design, brief 2A). */
  feed_like_count?: number;
  /** Whether the caller has hearted this post in the friends feed. */
  my_feed_like?: boolean;
  /** Total media items (1 = single). >1 means a carousel; set by resolveDeckMedia. */
  media_count?: number;
  /** Full ordered media (cover first) — only set when this is a carousel. */
  carousel?: { media_url: string; media_type: 'image' | 'video' }[];
  /** Video text/sticker overlays (raw jsonb from the RPC); parse with parseVideoOverlays. */
  overlays?: unknown;
  /** Deck card served through a paid boost slot (Part 5B). Always labelled. */
  is_boosted?: boolean;
  /** Sensitive-but-allowed (Part 6B): cover until tapped. Never sent to minors. */
  sensitive?: boolean;
  /** Part 9A: ASA disclosure — "Paid partnership" (with the brand's handle
   *  once the brand approves). Attached client-side per batch. */
  partner_label?: string;
  /** Part 8: this card is an ad — always labelled, swipeable like any post. */
  is_ad?: boolean;
  ad_id?: string | null;
  cta_label?: string | null;
  cta_url?: string | null;
  /** Plain-English "Why am I seeing this ad?" text from the server. */
  ad_reason?: string | null;
  /** Part 13C: which audience matched — 'broad' | 'personalised' | 'engaged' | 'similar'. */
  ad_kind?: string | null;
  /** Part 13D brand safety (set by the advertiser; enforced by arrangeAdPlacement). */
  ad_avoid_sensitive?: boolean | null;
  ad_blocked_topics?: string[] | null;
  ad_blocked_creators?: string[] | null;
};

/**
 * Part 13D: client-side deck arrangement for the ad slot. An ad is NEVER
 * adjacent to a sensitive card (unconditional — brand safety floor), and a
 * brand's blocked topics/creators keep its ad away from those cards too.
 * If no clean position exists in the batch, the ad is dropped (shown in a
 * later batch instead) rather than placed badly. `prevTail` is the last
 * already-dealt card, so the batch boundary is checked as well.
 */
export function arrangeAdPlacement(batch: DeckCard[], prevTail?: DeckCard | null): DeckCard[] {
  const adIdx = batch.findIndex((c) => c.is_ad);
  if (adIdx < 0) return batch;
  const ad = batch[adIdx];
  const rest = batch.filter((_, i) => i !== adIdx);

  const blockedTopics = (ad.ad_blocked_topics ?? []).map((t) => t.toLowerCase());
  const blockedCreators = new Set(ad.ad_blocked_creators ?? []);
  const clean = (c: DeckCard | null | undefined): boolean => {
    if (!c) return true; // deck edge is always fine
    if (c.is_ad) return true;
    if (c.sensitive) return false; // unconditional, whatever the advertiser set
    if (blockedCreators.has(c.user_id)) return false;
    if (blockedTopics.length > 0 && c.tags?.some((t) => blockedTopics.includes(t.toLowerCase())))
      return false;
    return true;
  };

  // Prefer the ad's served position; walk outward for the nearest clean slot.
  const candidates: number[] = [];
  for (let d = 0; d <= rest.length; d++) {
    if (adIdx - d >= 0) candidates.push(adIdx - d);
    if (d > 0 && adIdx + d <= rest.length) candidates.push(adIdx + d);
  }
  for (const i of candidates) {
    const before = i === 0 ? prevTail : rest[i - 1];
    if (clean(before) && clean(rest[i])) {
      return [...rest.slice(0, i), ad, ...rest.slice(i)];
    }
  }
  return rest; // no clean slot this batch — don't show the ad badly placed
}

export type SwipeDirection = 'left' | 'right';

export const DECK_BATCH_SIZE = 20;

/**
 * A batch fetcher shared by both feeds. Takes the exclude list of ids already loaded
 * into the client deck; returns the next candidate batch. Home and Following pass
 * different implementations so `useDeck` stays feed-agnostic.
 */
export type FetchBatch = (exclude: string[], limit?: number) => Promise<DeckCard[]>;

/**
 * Popular/discover posts for browse surfaces (Search default). Unlike fetchDeck this does
 * NOT exclude already-swiped posts, so it stays populated — ranked by tag affinity + recent
 * popularity. Sign media with resolveDeckMedia before display.
 */
export async function fetchDiscover(limit = 30): Promise<DeckCard[]> {
  const { data, error } = await supabase.rpc('get_discover', { _limit: limit });
  if (error) throw error;
  return (data ?? []) as DeckCard[];
}

/** Fetch a ranked batch, excluding posts already loaded into the client deck. */
export async function fetchDeck(exclude: string[], limit = DECK_BATCH_SIZE): Promise<DeckCard[]> {
  const { data, error } = await supabase.rpc('get_deck', {
    _limit: limit,
    _exclude: exclude,
  });
  if (error) throw error;
  return (data ?? []) as DeckCard[];
}

/**
 * Fetch a batch of the Following feed: unranked, strictly newest-first, drawn only from
 * accounts the caller accepted-follows. Same shape/paging as `fetchDeck` so the two feeds
 * share the deck machinery and the swipe/points/undo path unchanged.
 */
export async function fetchFollowingDeck(
  exclude: string[],
  limit = DECK_BATCH_SIZE,
): Promise<DeckCard[]> {
  const { data, error } = await supabase.rpc('get_following_deck', {
    _limit: limit,
    _exclude: exclude,
  });
  if (error) throw error;
  return (data ?? []) as DeckCard[];
}

/**
 * A page of the PERSISTENT Following feed (Instagram/TikTok-style): all recent posts
 * from accepted-follow accounts, newest-first, NOT consumed by swiping. Cursor-paginated
 * by the created_at of the last card you loaded (pass null for the first page).
 */
export async function fetchFollowingFeed(
  before: string | null,
  limit = 15,
): Promise<DeckCard[]> {
  const { data, error } = await supabase.rpc('get_following_feed', {
    _limit: limit,
    _before: before,
  });
  if (error) throw error;
  return (data ?? []) as DeckCard[];
}

/** Counts that let the Following tab pick the right empty state. */
export type FollowingSummary = {
  following_count: number;
  postable_count: number;
};

/**
 * How many accounts the caller follows, and how many eligible posts those accounts have
 * (ignoring swipes). Lets the Following tab tell "you follow nobody" from "nobody you
 * follow has posted" from "you're caught up".
 */
export async function getFollowingSummary(): Promise<FollowingSummary> {
  const { data, error } = await supabase.rpc('get_following_summary');
  if (error) throw error;
  const row = (data?.[0] ?? { following_count: 0, postable_count: 0 }) as FollowingSummary;
  return {
    following_count: Number(row.following_count ?? 0),
    postable_count: Number(row.postable_count ?? 0),
  };
}

/**
 * Record a swipe server-side: the client submits only the action (post + direction);
 * the server inserts the swipe and decides the points award. Idempotent, so retrying a
 * queued swipe is safe. Returns the new points balance.
 */
export async function recordSwipe(postId: string, direction: SwipeDirection): Promise<number> {
  const { data, error } = await supabase.rpc('record_swipe', {
    _post_id: postId,
    _direction: direction,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Heart (or un-heart) a post in the friends feed. NOT a deck swipe: it keeps its
 * own counter, earns no points, and never consumes the post from the deck
 * (brief 2A). Returns the new state and the feed-like counter.
 */
export async function toggleFeedLike(
  postId: string,
): Promise<{ liked: boolean; feed_like_count: number }> {
  const { data, error } = await supabase.rpc('toggle_feed_like', { _post_id: postId });
  if (error) throw error;
  const row = (data?.[0] ?? {}) as { liked?: boolean; feed_like_count?: number };
  return { liked: Boolean(row.liked), feed_like_count: Number(row.feed_like_count ?? 0) };
}

/** One row of a post's likers list (owner-only; Part 4B). */
export type PostLiker = {
  user_id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
  verified: boolean;
  liked_at: string;
  source: 'deck' | 'feed';
};

/**
 * Who liked YOUR post (deck likes + feed hearts, newest first, deduped).
 * The server refuses anyone but the post owner, and leaves out users who
 * turned on "Hide my likes". Left swipes have no equivalent — ever.
 */
export async function getPostLikers(
  postId: string,
  before: string | null = null,
  limit = 30,
): Promise<PostLiker[]> {
  const { data, error } = await supabase.rpc('get_post_likers', {
    _post_id: postId,
    _before: before,
    _limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as PostLiker[];
}

/** Reverse a single swipe: deletes the swipe row and posts a compensating ledger entry. */
export async function undoSwipe(postId: string): Promise<number> {
  const { data, error } = await supabase.rpc('undo_swipe', { _post_id: postId });
  if (error) throw error;
  return Number(data ?? 0);
}

/** A post the caller previously swiped, for the private Liked/Skipped review screen. */
export type SwipedPost = {
  post_id: string;
  thumbnail_url: string; // signed for display
  media_type: 'image' | 'video';
  swiped_at: string;
};

/**
 * The caller's own Liked ('right') or Skipped ('left') history, newest-first. Owner-only
 * (swipe anonymity). Thumbnails are signed here for display. Undo a choice with `undoSwipe`.
 */
export async function getMySwipes(
  direction: SwipeDirection,
  before: string | null = null,
  limit = 30,
): Promise<SwipedPost[]> {
  const { data, error } = await supabase.rpc('get_my_swipes', {
    _direction: direction,
    _limit: limit,
    _before: before,
  });
  if (error) throw error;
  const rows = (data ?? []) as SwipedPost[];
  const signed = await signMediaPaths(rows.map((r) => r.thumbnail_url));
  return rows.map((r) => ({ ...r, thumbnail_url: signed.get(r.thumbnail_url) ?? r.thumbnail_url }));
}
