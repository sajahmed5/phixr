import type { EmailOtpType } from '@supabase/supabase-js';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AuthScreen } from '@/components/ui/auth-screen';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { BRAND } from '@/constants/config';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';

/**
 * Email confirmation landing page: https://joinphixr.com/auth/confirm?token_hash=…&type=…
 *
 * The Supabase email templates link here (not to supabase.co), so on a phone with Phixr
 * installed the link is a universal link and opens the APP, which confirms the email and
 * signs the person in. Without the app it does the same on the website. Once there's a
 * session, the root auth guard routes on (profile setup, onboarding or the feed).
 */
const TYPES: EmailOtpType[] = ['signup', 'email', 'email_change', 'invite', 'magiclink'];

export default function ConfirmEmailScreen() {
  const router = useRouter();
  const { token_hash: tokenHash, type } = useLocalSearchParams<{ token_hash?: string; type?: string }>();
  const ran = useRef(false);
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      const otpType = (TYPES.includes(type as EmailOtpType) ? type : 'email') as EmailOtpType;
      if (!tokenHash) {
        setState('failed');
        return;
      }
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType });
      if (error) {
        setState('failed');
        return;
      }
      track('email_verified');
      setState('done');
      // The auth guard picks up the new session; nudge it along in case this screen is
      // the only one on the stack.
      setTimeout(() => router.replace('/(tabs)'), 600);
    })();
  }, [tokenHash, type, router]);

  if (state === 'failed') {
    return (
      <AuthScreen
        brand
        title="This link didn’t work"
        subtitle="It may have expired or already been used. If you’ve already confirmed your email, just log in.">
        <View style={{ gap: 12 }}>
          <Button title="Log in" onPress={() => router.replace('/(auth)/login')} />
        </View>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      brand
      title={state === 'done' ? 'Email confirmed' : 'Confirming your email…'}
      subtitle={state === 'done' ? 'Taking you to Phixr…' : undefined}>
      <View style={{ alignItems: 'center', paddingVertical: 24 }}>
        {state === 'done' ? (
          <FormMessage tone="success">You’re all set.</FormMessage>
        ) : (
          <ActivityIndicator color={BRAND.accent} />
        )}
      </View>
    </AuthScreen>
  );
}
