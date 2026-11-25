import { supabase } from '@/lib/supabase';

/**
 * Part 14C: two-step login (Supabase TOTP), one-time backup codes, and the
 * "This wasn't me" path. SMS backup arrives when Twilio is configured.
 */

export type SecurityStatus = {
  mfa_enrolled: boolean;
  backup_codes_left: number;
  /** True for team admins and accounts with earnings — 2FA is required. */
  mfa_required: boolean;
};

export async function getMySecurity(): Promise<SecurityStatus> {
  const { data, error } = await supabase.rpc('get_my_security');
  if (error) throw error;
  return data as SecurityStatus;
}

/** Start TOTP enrolment: returns the QR/secret for the authenticator app. */
export async function startEnrol(): Promise<{ factorId: string; secret: string; uri: string }> {
  // A previous unverified attempt blocks re-enrolment — clear it first.
  const { data: existing } = await supabase.auth.mfa.listFactors();
  for (const f of existing?.all ?? []) {
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) throw error;
  return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri };
}

/** Confirm the 6-digit code from the authenticator app. */
export async function confirmEnrol(factorId: string, code: string): Promise<void> {
  const challenge = await supabase.auth.mfa.challenge({ factorId });
  if (challenge.error) throw challenge.error;
  const verify = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code: code.trim(),
  });
  if (verify.error) throw verify.error;
}

/** Fresh set of 10 one-time backup codes — shown exactly once. */
export async function generateBackupCodes(): Promise<string[]> {
  const { data, error } = await supabase.rpc('generate_backup_codes');
  if (error) throw error;
  return (data ?? []) as string[];
}

/** Lost authenticator: a backup code removes the factor so it can be re-set-up. */
export async function recoverWithBackupCode(code: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('mfa-recover', { body: { code } });
  if (error) throw error;
  if ((data as { error?: string } | null)?.error) throw new Error(String((data as { error: string }).error));
}

/**
 * "This wasn't me": signs the account out EVERYWHERE and emails a password
 * reset. The caller should treat the local session as gone afterwards.
 */
export async function secureAccount(): Promise<void> {
  const { error } = await supabase.functions.invoke('secure-account', { body: {} });
  if (error) throw error;
}
