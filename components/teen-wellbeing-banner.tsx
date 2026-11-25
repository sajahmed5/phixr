import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { getClientSettings, settingNumber } from '@/lib/settings';

/** When this app session started (survives screen remounts, resets on relaunch). */
const SESSION_START = Date.now();

/**
 * Gentle teen wellbeing nudges (brief 6A): a quiet-hours note at night and a
 * time reminder after a continuous stretch, for under-18 accounts only.
 * Admin-tunable via client-visible settings; dismissible, never blocking —
 * "gentle" is the design requirement.
 */
export function TeenWellbeingBanner() {
  const theme = useTheme();
  const { profile } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const isMinor = profile?.age_band === 'minor';

  useEffect(() => {
    if (!isMinor) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    void getClientSettings().then((s) => {
      const quietStart = settingNumber(s, 'teen_quiet_start_hour', 22);
      const quietEnd = settingNumber(s, 'teen_quiet_end_hour', 7);
      const reminderMin = settingNumber(s, 'teen_time_reminder_minutes', 60);
      const check = () => {
        const hour = new Date().getHours();
        const inQuiet =
          quietStart > quietEnd
            ? hour >= quietStart || hour < quietEnd // crosses midnight
            : hour >= quietStart && hour < quietEnd;
        const minutes = Math.floor((Date.now() - SESSION_START) / 60000);
        if (inQuiet) {
          setMessage("It's getting late — Phixr will still be here tomorrow. Sleep well 🌙");
        } else if (minutes >= reminderMin) {
          setMessage(
            `You've been scrolling for a while (${minutes} min). A little break never hurts.`,
          );
        } else {
          setMessage(null);
        }
      };
      check();
      timer = setInterval(check, 60000);
    });
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isMinor]);

  if (!isMinor || !message || dismissed === message) return null;

  return (
    <View style={[styles.banner, { backgroundColor: theme.backgroundSelected }]}>
      <Ionicons name="moon-outline" size={18} color={theme.textSecondary} />
      <ThemedText type="small" style={styles.text}>
        {message}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss reminder"
        hitSlop={8}
        onPress={() => setDismissed(message)}>
        <Ionicons name="close" size={18} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    borderRadius: 12,
  },
  text: { flex: 1 },
});
