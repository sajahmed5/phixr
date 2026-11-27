import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { mediaSource, signMediaPaths } from '@/lib/media';
import {
  createHighlight, deleteHighlight, getHighlightItems, getHighlights,
  getProfileLinks, recordLinkTap,
  type Highlight, type HighlightItem, type ProfileLink,
} from '@/lib/showcase';

/** Part 12C: link-in-bio pills. Taps are counted (totals only). */
export function ProfileLinksRow({ userId }: { userId: string }) {
  const theme = useTheme();
  const [links, setLinks] = useState<ProfileLink[]>([]);
  useEffect(() => {
    void getProfileLinks(userId).then(setLinks).catch(() => {});
  }, [userId]);
  if (links.length === 0) return null;
  return (
    <View style={styles.linksWrap}>
      {links.map((l) => (
        <Pressable
          key={l.id}
          accessibilityRole="link"
          onPress={() => {
            recordLinkTap(l.id);
            void Linking.openURL(l.url).catch(() => Alert.alert("Couldn't open that link"));
          }}
          style={[styles.linkPill, { borderColor: theme.border }]}>
          <Ionicons name="link-outline" size={13} color={BRAND.accent} />
          <ThemedText type="small" numberOfLines={1} style={styles.linkText}>
            {l.title}
          </ThemedText>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Part 12C: story-highlight circles + a simple pager viewer. Items are
 * audience-filtered SERVER-SIDE (get_highlight_items), so a group-only story
 * simply isn't there for outsiders — nothing hints why.
 */
export function HighlightsRail({ userId, isOwner }: { userId: string; isOwner: boolean }) {
  const theme = useTheme();
  const [rail, setRail] = useState<Highlight[]>([]);
  const [open, setOpen] = useState<Highlight | null>(null);
  const [items, setItems] = useState<(HighlightItem & { signed?: string })[]>([]);
  const [idx, setIdx] = useState(0);
  const [covers, setCovers] = useState<Map<string, string>>(new Map());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const load = () => {
    getHighlights(userId)
      .then(async (hs) => {
        setRail(hs);
        const keys = hs.map((h) => h.cover_url).filter(Boolean) as string[];
        setCovers(await signMediaPaths(keys));
      })
      .catch(() => {});
  };
  useEffect(load, [userId]);

  const openHighlight = async (h: Highlight) => {
    try {
      const raw = await getHighlightItems(h.id);
      if (raw.length === 0) {
        Alert.alert('Nothing to show', 'This highlight has no stories you can view.');
        return;
      }
      const signed = await signMediaPaths(raw.map((i) => i.media_url));
      setItems(raw.map((i) => ({ ...i, signed: signed.get(i.media_url) })));
      setIdx(0);
      setOpen(h);
    } catch {
      /* noop */
    }
  };

  if (rail.length === 0 && !isOwner) return null;
  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {rail.map((h) => (
          <Pressable
            key={h.id}
            onPress={() => void openHighlight(h)}
            onLongPress={
              isOwner
                ? () =>
                    Alert.alert('Delete highlight?', `“${h.name}” is removed from your profile.`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => void deleteHighlight(h.id).then(load) },
                    ])
                : undefined
            }
            accessibilityRole="button"
            accessibilityLabel={`Highlight ${h.name}`}
            style={styles.highlight}>
            {h.cover_url && covers.get(h.cover_url) ? (
              <Image source={mediaSource(covers.get(h.cover_url))} style={[styles.circle, { borderColor: theme.border }]} contentFit="cover" />
            ) : (
              <View style={[styles.circle, styles.circleEmpty, { borderColor: theme.border }]}>
                <Ionicons name="images-outline" size={18} color={theme.textSecondary} />
              </View>
            )}
            <ThemedText type="small" numberOfLines={1} style={styles.hlName}>
              {h.name}
            </ThemedText>
          </Pressable>
        ))}
        {isOwner ? (
          <Pressable onPress={() => setCreating(true)} accessibilityRole="button" style={styles.highlight}>
            <View style={[styles.circle, styles.circleEmpty, { borderColor: theme.border }]}>
              <Ionicons name="add" size={20} color={theme.text} />
            </View>
            <ThemedText type="small" style={styles.hlName}>New</ThemedText>
          </Pressable>
        ) : null}
      </ScrollView>

      {/* Viewer */}
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable style={styles.viewerBackdrop} onPress={() => setOpen(null)}>
          {items[idx] ? (
            <View style={styles.viewerBody}>
              <ThemedText type="smallBold" style={styles.viewerTitle}>
                {open?.name} · {idx + 1}/{items.length}
              </ThemedText>
              <Image source={mediaSource(items[idx].signed)} style={styles.viewerImage} contentFit="contain" />
              {items[idx].overlay_text ? (
                <ThemedText type="default" style={styles.viewerOverlay}>
                  {items[idx].overlay_text}
                </ThemedText>
              ) : null}
              <View style={styles.viewerNav}>
                <Pressable style={styles.navHalf} onPress={() => setIdx(Math.max(0, idx - 1))} />
                <Pressable
                  style={styles.navHalf}
                  onPress={() => (idx + 1 < items.length ? setIdx(idx + 1) : setOpen(null))}
                />
              </View>
            </View>
          ) : null}
        </Pressable>
      </Modal>

      {/* Create */}
      <Modal visible={creating} transparent animationType="slide" onRequestClose={() => setCreating(false)}>
        <Pressable style={styles.viewerBackdrop} onPress={() => setCreating(false)} />
        <View style={[styles.createSheet, { backgroundColor: theme.background }]}>
          <ThemedText type="subtitle">New highlight</ThemedText>
          <TextField label="" placeholder="Name" value={name} onChangeText={setName} maxLength={30} />
          <ThemedText type="small" themeColor="textSecondary">
            Add stories to it from your own story view — each keeps its original audience.
          </ThemedText>
          <Button
            title="Create"
            disabled={!name.trim()}
            onPress={() =>
              createHighlight(name)
                .then(() => {
                  setCreating(false);
                  setName('');
                  load();
                })
                .catch((e) => Alert.alert("Couldn't create", e instanceof Error ? e.message : 'Try again.'))
            }
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  linksWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 6 },
  linkPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, maxWidth: 220,
  },
  linkText: { flexShrink: 1 },
  rail: { paddingHorizontal: 14, paddingVertical: 8, gap: 14 },
  highlight: { alignItems: 'center', width: 64 },
  circle: { width: 56, height: 56, borderRadius: 28, borderWidth: 2 },
  circleEmpty: { alignItems: 'center', justifyContent: 'center' },
  hlName: { marginTop: 3, maxWidth: 62 },
  viewerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center' },
  viewerBody: { flex: 1, justifyContent: 'center' },
  viewerTitle: { color: '#fff', textAlign: 'center', marginTop: 54 },
  viewerImage: { flex: 1, marginVertical: 12 },
  viewerOverlay: { color: '#fff', textAlign: 'center', marginBottom: 48, paddingHorizontal: 24 },
  viewerNav: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, flexDirection: 'row' },
  navHalf: { flex: 1 },
  createSheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 34, gap: 10,
  },
});
