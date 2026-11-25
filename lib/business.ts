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

// ---------------------------------------------------------------------------
// Part 13: teams, offers, hours/links, insights. All checks server-side
// (has_team_role); the owner implicitly has every role.
// ---------------------------------------------------------------------------

export type TeamRole = 'admin' | 'editor' | 'analyst' | 'moderator';

export const TEAM_ROLE_BLURB: Record<TeamRole, string> = {
  admin: 'Everything, including billing and the team',
  editor: 'Posts, ads and schedules',
  analyst: 'Reports, read-only',
  moderator: 'Comments and messages',
};

export type TeamMember = {
  member_id: string;
  role: TeamRole;
  status: 'pending' | 'accepted';
  profiles: { handle: string; display_name: string | null; avatar_url: string | null } | null;
};

/** The businesses this signed-in user can act for (accepted memberships). */
export type ActingBusiness = {
  business_id: string;
  role: TeamRole;
  profiles: { handle: string; display_name: string | null; avatar_url: string | null } | null;
};

export async function listTeam(businessId: string): Promise<TeamMember[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('member_id, role, status, profiles!team_members_member_id_fkey (handle, display_name, avatar_url)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TeamMember[];
}

export async function myActingBusinesses(roles?: TeamRole[]): Promise<ActingBusiness[]> {
  const { data: u } = await supabase.auth.getUser();
  let q = supabase
    .from('team_members')
    .select('business_id, role, profiles!team_members_business_id_fkey (handle, display_name, avatar_url)')
    .eq('member_id', u.user!.id)
    .eq('status', 'accepted');
  if (roles && roles.length > 0) q = q.in('role', roles);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as ActingBusiness[];
}

export async function inviteTeamMember(businessId: string, who: string, role: TeamRole): Promise<void> {
  const { error } = await supabase.rpc('invite_team_member', {
    _business: businessId, _who: who, _role: role,
  });
  if (error) throw error;
}

export async function respondTeamInvite(businessId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_team_invite', { _business: businessId, _accept: accept });
  if (error) throw error;
}

export async function removeTeamMember(businessId: string, memberId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_team_member', { _business: businessId, _member: memberId });
  if (error) throw error;
}

// --- Hours + action links ---------------------------------------------------

/** "09:00-17:00" style string per day, or null/absent = closed. */
export type BusinessHours = Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', string>>;

export type BusinessExtras = {
  business_hours: BusinessHours | null;
  menu_url: string | null;
  booking_url: string | null;
};

export async function getBusinessExtras(businessId: string): Promise<BusinessExtras | null> {
  const { data, error } = await supabase.rpc('get_business_extras', { _business: businessId });
  if (error) throw error;
  return (data ?? null) as BusinessExtras | null;
}

export async function setBusinessDetails(
  businessId: string,
  hours: BusinessHours | null,
  menuUrl: string | null,
  bookingUrl: string | null,
): Promise<void> {
  const { error } = await supabase.rpc('set_business_details', {
    _business: businessId, _hours: hours, _menu_url: menuUrl, _booking_url: bookingUrl,
  });
  if (error) throw error;
}

// --- Offers ------------------------------------------------------------------

export type Offer = { id: string; title: string; details: string | null; ends_at: string | null };

export async function getBusinessOffers(businessId: string): Promise<Offer[]> {
  const { data, error } = await supabase.rpc('get_business_offers', { _business: businessId });
  if (error) throw error;
  return (data ?? []) as Offer[];
}

export async function createOffer(
  businessId: string, title: string, details: string | null, endsAt: Date | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('create_offer', {
    _business: businessId, _title: title, _details: details,
    _ends_at: endsAt ? endsAt.toISOString() : null,
  });
  if (error) throw error;
  return data as string;
}

export async function endOffer(offerId: string): Promise<void> {
  const { error } = await supabase.rpc('end_offer', { _offer_id: offerId });
  if (error) throw error;
}

// --- Venue map card ----------------------------------------------------------

export type VenueBusiness = {
  business_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  business_hours: BusinessHours | null;
  menu_url: string | null;
  booking_url: string | null;
  offers: Offer[];
};

export async function getVenueBusiness(venueId: string): Promise<VenueBusiness | null> {
  const { data, error } = await supabase.rpc('get_venue_business', { _venue_id: venueId });
  if (error) throw error;
  return (data ?? null) as VenueBusiness | null;
}

// --- Insights ----------------------------------------------------------------

export type InsightKind =
  | 'profile_view' | 'hours_view' | 'menu_click' | 'booking_click' | 'offer_view' | 'offer_click';

/** Fire-and-forget: one count per person per day, server-deduped; never throws. */
export function recordBusinessInsight(businessId: string, kind: InsightKind): void {
  void supabase.rpc('record_business_insight', { _business: businessId, _kind: kind }).then(
    () => undefined,
    () => undefined,
  );
}

export type BusinessInsights = {
  since: string;
  daily: { day: string; kind: InsightKind; n: number }[];
  totals: Partial<Record<InsightKind, number>>;
};

export async function getBusinessInsights(businessId: string, days = 30): Promise<BusinessInsights> {
  const { data, error } = await supabase.rpc('get_business_insights', { _business: businessId, _days: days });
  if (error) throw error;
  return data as BusinessInsights;
}

// --- Acting as the business: inbox + posting ---------------------------------

export type BusinessConversation = {
  conversation_id: string;
  other_handle: string;
  other_display_name: string | null;
  last_body: string | null;
  last_at: string | null;
};

export async function getBusinessConversations(businessId: string): Promise<BusinessConversation[]> {
  const { data, error } = await supabase.rpc('get_business_conversations', { _business: businessId });
  if (error) throw error;
  return (data ?? []) as BusinessConversation[];
}

export async function sendMessageAsBusiness(businessId: string, conversationId: string, body: string): Promise<string> {
  const { data, error } = await supabase.rpc('send_message_as_business', {
    _business: businessId, _cid: conversationId, _body: body,
  });
  if (error) throw error;
  return data as string;
}

export async function saveBusinessDraft(
  businessId: string,
  payload: Record<string, unknown>,
  mediaStatus: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('save_business_draft', {
    _business: businessId, _payload: payload, _media_status: mediaStatus,
  });
  if (error) throw error;
  return data as string;
}

export async function scheduleBusinessDraft(businessId: string, draftId: string, when: Date): Promise<void> {
  const { error } = await supabase.rpc('schedule_business_draft', {
    _business: businessId, _draft_id: draftId, _when: when.toISOString(),
  });
  if (error) throw error;
}

export async function teamDeleteComment(businessId: string, commentId: string): Promise<void> {
  const { error } = await supabase.rpc('team_delete_comment', { _business: businessId, _comment_id: commentId });
  if (error) throw error;
}
