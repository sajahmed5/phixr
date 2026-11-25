import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { Alert, AppState } from 'react-native';

import { useAuth } from '@/lib/auth-context';
import { getClientSettings } from '@/lib/settings';
import { getMyWellbeing } from '@/lib/wellbeing';

/**
 * Part 14D: daily time reminder + take-a-break, counted while a deck is on
 * screen and the app is foregrounded. Optional for adults (their own
 * minutes), ON BY DEFAULT for teens (admin setting teen_time_reminder_minutes;
 * 0 turns it off platform-wide). Continuous-session minutes reset when the
 * deck unmounts or the app backgrounds for 5+ minutes.
 */
export function useWellbeingTimers(): void {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const isMinor = (profile as { age_band?: string } | null)?.age_band === 'minor';

  const continuous = useRef(0);
  const backgroundedAt = useRef<number | null>(null);
  const breakShown = useRef(false);

  useEffect(() => {
    if (!uid) return;
    let reminderMin: number | null = null;
    let breakMin = 30;
    let alive = true;

    void (async () => {
      try {
        const cs = (await getClientSettings()) as Record<string, unknown>;
        breakMin = Number(cs.take_break_minutes) || 30;
        const teenDefault = Number(cs.teen_time_reminder_minutes) || 0;
        const mine = await getMyWellbeing().catch(() => null);
        reminderMin = mine?.time_reminder_minutes ?? (isMinor && teenDefault > 0 ? teenDefault : null);
      } catch {
        // timers are a kindness, never a blocker
      }
    })();

    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        if (backgroundedAt.current && Date.now() - backgroundedAt.current > 5 * 60 * 1000) {
          continuous.current = 0; // a real break resets the session counter
          breakShown.current = false;
        }
        backgroundedAt.current = null;
      } else {
        backgroundedAt.current = Date.now();
      }
    });

    const dayKey = () => `wellbeing:minutes:${uid}:${new Date().toISOString().slice(0, 10)}`;
    const tick = setInterval(() => {
      if (!alive || backgroundedAt.current !== null || AppState.currentState !== 'active') return;
      continuous.current += 1;
      void (async () => {
        try {
          const key = dayKey();
          const total = (parseInt((await AsyncStorage.getItem(key)) ?? '0', 10) || 0) + 1;
          await AsyncStorage.setItem(key, String(total));

          if (reminderMin && total >= reminderMin) {
            const flag = `${key}:reminded`;
            if (!(await AsyncStorage.getItem(flag))) {
              await AsyncStorage.setItem(flag, '1');
              Alert.alert(
                'Time check',
                `You've been swiping for ${total} minutes today. Just so you know 💛`,
                [{ text: 'Thanks' }],
              );
              return; // one prompt per tick at most
            }
          }
          if (!breakShown.current && continuous.current >= breakMin) {
            breakShown.current = true;
            Alert.alert(
              'Fancy a stretch?',
              `You've been going ${continuous.current} minutes straight. The deck will still be here.`,
              [{ text: 'Keep going' }, { text: 'Take a break', style: 'cancel' }],
            );
          }
        } catch {
          // storage hiccups never interrupt the deck
        }
      })();
    }, 60 * 1000);

    return () => {
      alive = false;
      clearInterval(tick);
      sub.remove();
    };
  }, [uid, isMinor]);
}
