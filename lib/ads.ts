import { supabase } from '@/lib/supabase';

/**
 * Ads in the app (Part 8C/8D). Ads arrive as deck cards flagged is_ad —
 * always labelled Sponsored, swipeable exactly like posts. Hide, report and
 * "Why am I seeing this?" live on every ad card. Consent is a clear choice
 * recorded with a timestamp and changeable in settings; minors can never
 * choose personalised.
 */

export type AdsConsent = 'unset' | 'personalised' | 'non_personalised';

export async function setAdsConsent(choice: 'personalised' | 'non_personalised'): Promise<void> {
  const { error } = await supabase.rpc('set_ads_consent', { _choice: choice });
  if (error) throw error;
}

export async function getAdsConsent(): Promise<AdsConsent> {
  // Own-row read via get_my_profile (ads_consent is own-only post column-privacy).
  const { data, error } = await supabase.rpc('get_my_profile');
  if (error) return 'unset';
  return ((data as { ads_consent: AdsConsent }).ads_consent ?? 'unset') as AdsConsent;
}

/** Hide an ad: it is never served to this user again. */
export async function hideAd(adId: string): Promise<void> {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase.from('ad_hides').insert({ user_id: u.user!.id, ad_id: adId });
  if (error && error.code !== '23505') throw error;
}

/** Fire-and-forget click (opens the CTA; billing counts genuine clicks). */
export function recordAdClick(adId: string): void {
  void supabase.rpc('record_ad_click', { _ad_id: adId }).then(() => {}, () => {});
}
