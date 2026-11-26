import { supabase } from '@/lib/supabase';

/**
 * Publishing API — the signed-in side: the "Connect to Phixr" consent screen and
 * Settings → Connected apps. Every check lives in the database (oauth_describe,
 * oauth_approve, my_connected_apps, revoke_connected_app).
 */

export type ApiScope = 'account:read' | 'posts:read' | 'posts:write' | 'insights:read';

/** Plain-English wording for each permission, shown on the consent screen. */
export const SCOPE_TEXT: Record<ApiScope, string> = {
  'account:read': 'See your account name, handle and profile picture',
  'posts:read': 'See the posts it creates for you and whether they have gone live',
  'posts:write': 'Upload photos and videos, and create, schedule, edit and delete the posts it makes for you',
  'insights:read': 'See view, like, save and follower totals (never who skipped your posts)',
};

export type ConsentAccount = {
  id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  eligible: boolean;
  reason: 'not_business' | 'app_in_test_mode' | null;
  connected: boolean;
};

export type ConsentRequest = {
  app: {
    name: string;
    description: string | null;
    website_url: string | null;
    privacy_url: string | null;
    logo_url: string | null;
    status: 'test' | 'in_review' | 'live' | 'suspended';
  };
  scopes: ApiScope[];
  accounts: ConsentAccount[];
  adult: boolean;
};

export async function describeConsent(clientId: string, redirectUri: string, scopes: string[]): Promise<ConsentRequest> {
  const { data, error } = await supabase.rpc('oauth_describe', {
    _client_id: clientId,
    _redirect_uri: redirectUri,
    _scopes: scopes,
  });
  if (error) throw new Error(error.message);
  return data as ConsentRequest;
}

export async function approveConsent(args: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  businessId: string;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('oauth_approve', {
    _client_id: args.clientId,
    _redirect_uri: args.redirectUri,
    _scopes: args.scopes,
    _business: args.businessId,
    _code_challenge: args.codeChallenge,
    _code_challenge_method: args.codeChallengeMethod,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Add OAuth result parameters to the app's redirect URL. */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export type ConnectedApp = {
  grant_id: string;
  app_name: string;
  app_website: string | null;
  app_status: string;
  scopes: ApiScope[];
  connected_by: string | null;
  created_at: string;
  last_used_at: string | null;
};

export async function listConnectedApps(businessId?: string): Promise<ConnectedApp[]> {
  const { data, error } = await supabase.rpc('my_connected_apps', businessId ? { _business: businessId } : {});
  if (error) throw new Error(error.message);
  return (data ?? []) as ConnectedApp[];
}

export async function removeConnectedApp(grantId: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_connected_app', { _grant_id: grantId });
  if (error) throw new Error(error.message);
}
