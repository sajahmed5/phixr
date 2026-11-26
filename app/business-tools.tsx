import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { BusinessOnly } from '@/components/business-only';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';

type Tool = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  href: Href;
};

/** Everything a business account gets, in one tidy place (opened from the profile). */
const SECTIONS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Insights',
    tools: [
      {
        icon: 'bar-chart-outline',
        label: 'Analytics',
        hint: 'Reach, likes, best times to post, follower growth and your boosts',
        href: '/analytics',
      },
    ],
  },
  {
    title: 'Content',
    tools: [
      { icon: 'albums-outline', label: 'Drafts', hint: 'Posts you’ve saved to finish later', href: '/drafts' },
      {
        icon: 'calendar-outline',
        label: 'Scheduled posts',
        hint: 'Your content calendar — posts go out automatically',
        href: '/schedule',
      },
    ],
  },
  {
    title: 'Money',
    tools: [
      { icon: 'cash-outline', label: 'Earnings', hint: 'Your balance and payouts', href: '/settings/earnings' },
      {
        icon: 'pricetag-outline',
        label: 'Paid partnerships',
        hint: 'Requests from creators tagging your brand',
        href: '/settings/partnerships',
      },
    ],
  },
  {
    title: 'Your business',
    tools: [
      {
        icon: 'time-outline',
        label: 'Hours, links & offers',
        hint: 'What customers see on your profile',
        href: '/business/details',
      },
      { icon: 'chatbubbles-outline', label: 'Business inbox', hint: 'Messages to your business', href: '/business/inbox' },
      { icon: 'people-outline', label: 'Team', hint: 'Invite people to help run your account', href: '/business/team' },
      {
        icon: 'construct-outline',
        label: 'Profile tools',
        hint: 'Bio links, category, quick replies and comment controls',
        href: '/settings/creator-tools',
      },
    ],
  },
  {
    title: 'Account',
    tools: [
      {
        icon: 'briefcase-outline',
        label: 'Business account settings',
        hint: 'Venues, or switch back to personal',
        href: '/settings/business',
      },
    ],
  },
];

export default function BusinessToolsScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Business tools' }} />
      <BusinessOnly feature="Business tools">
        <Hub />
      </BusinessOnly>
    </>
  );
}

function Hub() {
  const theme = useTheme();
  const router = useRouter();
  return (
    <ThemedView style={styles.fill}>
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
          Tip: to promote a post, open it from your profile and tap Boost.
        </ThemedText>
        {SECTIONS.map((section) => (
          <View key={section.title} style={styles.group}>
            <ThemedText type="smallBold" themeColor="textSecondary" style={styles.groupTitle}>
              {section.title.toUpperCase()}
            </ThemedText>
            <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
              {section.tools.map((t, i) => (
                <Pressable
                  key={t.label}
                  onPress={() => router.push(t.href)}
                  accessibilityRole="button"
                  accessibilityHint={t.hint}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
                    pressed && styles.pressed,
                  ]}>
                  <View style={[styles.iconWrap, { backgroundColor: theme.background }]}>
                    <Ionicons name={t.icon} size={19} color={BRAND.accent} />
                  </View>
                  <View style={styles.text}>
                    <ThemedText type="default">{t.label}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                      {t.hint}
                    </ThemedText>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
                </Pressable>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16, gap: 22, paddingBottom: 48 },
  intro: { paddingHorizontal: 4 },
  group: { gap: 8 },
  groupTitle: { paddingHorizontal: 4, letterSpacing: 0.5 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  pressed: { opacity: 0.7 },
  iconWrap: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 1 },
});
