import { supabase } from '@/lib/supabase';

/**
 * Business accounts (Part 7C). Switching is 18+ (server-enforced); a business
 * claims one or more venues (chains claim every branch). Verification is the
 * manual fame-admin path until Google Business Profile API access is approved
 * — unverified businesses work fully, minus the badge, and can't claim a
 * venue a verified business owns.
 */

export type VenueClaim = {
  venue_id: string;
  verified: boolean;
  venues: {
    name: string;
    category: string | null;
    address: string | null;
  } | null;
};

export async function setAccountType(type: 'personal' | 'business'): Promise<void> {
  const { error } = await supabase.rpc('set_account_type', { _type: type });
  if (error) throw error;
}

export async function myVenueClaims(): Promise<VenueClaim[]> {
  const { data: u } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('business_venues')
    .select('venue_id, verified, venues (name, category, address)')
    .eq('business_id', u.user!.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as VenueClaim[];
}

/** Claim a place from the picker: upserts the venue row, then claims it. */
export async function claimPlace(place: {
  provider?: string;
  provider_place_id: string;
  name: string;
  category?: string | null;
  lat?: number | null;
  lon?: number | null;
  address?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('claim_place', {
    _provider: place.provider ?? 'google',
    _provider_place_id: place.provider_place_id,
    _name: place.name,
    _category: place.category ?? null,
    _lat: place.lat ?? null,
    _lon: place.lon ?? null,
    _address: place.address ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function unclaimVenue(venueId: string): Promise<void> {
  const { error } = await supabase.rpc('unclaim_venue', { _venue_id: venueId });
  if (error) throw error;
}
