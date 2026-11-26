import { useAuth } from '@/lib/auth-context';

/**
 * Personal vs business accounts.
 *
 * Personal (the default) is for friends and scrolling: post, swipe, follow, message,
 * stories, comments. No promotion, no creator tools, no earnings.
 *
 * Business (Settings → Business account, adults only) unlocks everything for creators
 * and businesses: drafts and scheduling, analytics, boosts, paid partnerships, earnings
 * and payouts, bio links, teams, the business inbox, offers and ads.
 *
 * The UI uses this to decide what to show; the server enforces the money and promotion
 * features on its own (migration 20261126200000_business_only_features).
 */
export function isBusinessProfile(profile: unknown): boolean {
  return (profile as { account_type?: string } | null)?.account_type === 'business';
}

export function useIsBusiness(): boolean {
  const { profile } = useAuth();
  return isBusinessProfile(profile);
}
