import { supabase } from '@/lib/supabase';

/**
 * Part 14D: wellbeing preferences. One own-rows table; quiet-hours muting is
 * enforced server-side (send-push + the DM auto-reply trigger), the timers
 * are client-side (use-wellbeing-timers).
 */

export type Wellbeing = {
  quiet_start_min: number | null; // minutes-of-day, Europe/London
  quiet_end_min: number | null;
  quiet_auto_reply: string | null;
  time_reminder_minutes: number | null; // null = off (teens get the admin default)
  hide_like_counts_others: boolean;
  hide_like_counts_mine: boolean;
};

export const DEFAULT_WELLBEING: Wellbeing = {
  quiet_start_min: null,
  quiet_end_min: null,
  quiet_auto_reply: null,
  time_reminder_minutes: null,
  hide_like_counts_others: false,
  hide_like_counts_mine: false,
};

let cache: Wellbeing | null = null;

export async function getMyWellbeing(force = false): Promise<Wellbeing> {
  if (cache && !force) return cache;
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return DEFAULT_WELLBEING;
  const { data, error } = await supabase
    .from('user_wellbeing')
    .select('quiet_start_min, quiet_end_min, quiet_auto_reply, time_reminder_minutes, hide_like_counts_others, hide_like_counts_mine')
    .eq('user_id', u.user.id)
    .maybeSingle();
  if (error) throw error;
  cache = (data as Wellbeing | null) ?? DEFAULT_WELLBEING;
  return cache;
}

export async function setMyWellbeing(patch: Partial<Wellbeing>): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) throw new Error('not signed in');
  const current = await getMyWellbeing(true);
  const next = { ...current, ...patch };
  const { error } = await supabase
    .from('user_wellbeing')
    .upsert({ user_id: u.user.id, ...next, updated_at: new Date().toISOString() });
  if (error) throw error;
  cache = next;
}

export function clearWellbeingCache(): void {
  cache = null;
}
