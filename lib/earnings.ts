import { supabase } from '@/lib/supabase';

/**
 * Part 9D: creator earnings. Everything is behind the server-side
 * creator_earnings_enabled flag; payouts stay off until Stripe Connect keys
 * exist (`payouts_live`). Under-18s are refused server-side.
 */

export type EarningsEntry = {
  id: string;
  kind: 'partnership' | 'ad_revenue_share' | 'adjustment';
  amount_pence: number;
  vat_pence: number;
  note: string | null;
  created_at: string;
};

export type MyEarnings = {
  enabled: boolean;
  balance_pence: number;
  lifetime_pence: number;
  pending_payout_pence: number;
  min_payout_pence: number;
  payouts_live: boolean;
  entries: EarningsEntry[];
};

export async function getMyEarnings(): Promise<MyEarnings> {
  const { data, error } = await supabase.rpc('get_my_earnings');
  if (error) throw new Error(error.message);
  return data as MyEarnings;
}

export async function requestPayout(amountPence: number): Promise<void> {
  const { error } = await supabase.rpc('request_payout', { _amount_pence: amountPence });
  if (error) throw new Error(error.message);
}
