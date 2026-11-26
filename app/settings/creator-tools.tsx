import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { isBusinessProfile } from '@/lib/account-type';
import { useAuth } from '@/lib/auth-context';
import {
  addHiddenWord,
  addProfileLink,
  deleteQuickReply,
  getHiddenWords,
  getProfileLinks,
  getQuickReplies,
  removeHiddenWord,
  removeProfileLink,
  saveQuickReply,
  setCommentLimit,
  setProfileCategory,
  setUseDefaultHiddenWords,
  type ProfileLink,
  type QuickReply,
} from '@/lib/showcase';

/**
 * Part 12C/12E creator tools, one-handed: link in bio (with tap counts),
 * profile category, hidden words, comment limits and quick replies.
 * Personal accounts see only the comment safety controls ("Comment controls").
 */
export default function CreatorToolsScreen() {
  const theme = useTheme();
  const { user, profile, reload } = useAuth();
  // Personal accounts get the safety controls (hidden words, comment limits); bio links,
  // category and quick replies are business tools.
  const isBusiness = isBusinessProfile(profile);

  // Links
  const [links, setLinks] = useState<ProfileLink[]>([]);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  // Hidden words
  const [words, setWords] = useState<string[]>([]);
  const [newWord, setNewWord] = useState('');
  const [useDefaults, setUseDefaults] = useState(
    (profile as { use_default_hidden_words?: boolean } | null)?.use_default_hidden_words ?? true,
  );
  // Comment limit
  const [limit, setLimit] = useState<string | null>(
    (profile as { comment_limit?: string | null } | null)?.comment_limit ?? null,
  );
  // Quick replies
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [qrShortcut, setQrShortcut] = useState('');
  const [qrBody, setQrBody] = useState('');
  // Category
  const [category, setCategory] = useState(
    (profile as { category?: string | null } | null)?.category ?? '',
  );

  useEffect(() => {
    if (!user?.id) return;
    void getProfileLinks(user.id)
      .then(setLinks)
      .catch(() => {});
    void getHiddenWords()
      .then(setWords)
      .catch(() => {});
    void getQuickReplies()
      .then(setReplies)
      .catch(() => {});
  }, [user?.id]);

  const onError = (e: unknown) =>
    Alert.alert('Something went wrong', e instanceof Error ? e.message : 'Try again.');

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen
        options={{ headerShown: true, title: isBusiness ? 'Profile tools' : 'Comment controls' }}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {isBusiness ? (
          <>
            {/* --- Category --- */}
            <ThemedText type="subtitle">Profile category</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Shown under your name — e.g. “Food creator” or “Pizza restaurant”.
            </ThemedText>
            <TextField
              label=""
              placeholder="e.g. Food creator"
              value={category}
              onChangeText={setCategory}
              maxLength={40}
            />
            <Button
              title="Save category"
              variant="secondary"
              onPress={() =>
                setProfileCategory(category || null)
                  .then(reload)
                  .catch(onError)
              }
            />

            {/* --- Link in bio --- */}
            <ThemedText type="subtitle" style={styles.sectionTop}>
              Links
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Up to 5 links on your profile. Taps are counted (totals only).
            </ThemedText>
            {links.map((l) => (
              <View key={l.id} style={[styles.row, { borderColor: theme.border }]}>
                <View style={styles.rowBody}>
                  <ThemedText type="smallBold" numberOfLines={1}>
                    {l.title}
                  </ThemedText>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    numberOfLines={1}
                    onPress={() => void Linking.openURL(l.url)}>
                    {l.url}
                  </ThemedText>
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  {l.tap_count} taps
                </ThemedText>
                <ThemedText
                  type="small"
                  style={{ color: BRAND.accent }}
                  onPress={() =>
                    removeProfileLink(l.id)
                      .then(() => setLinks(links.filter((x) => x.id !== l.id)))
                      .catch(onError)
                  }>
                  Remove
                </ThemedText>
              </View>
            ))}
            {links.length < 5 ? (
              <>
                <TextField
                  label=""
                  placeholder="Title"
                  value={linkTitle}
                  onChangeText={setLinkTitle}
                  maxLength={40}
                />
                <TextField
                  label=""
                  placeholder="https://"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={linkUrl}
                  onChangeText={setLinkUrl}
                />
                <Button
                  title="Add link"
                  variant="secondary"
                  disabled={!linkTitle.trim() || !linkUrl.trim()}
                  onPress={() =>
                    addProfileLink(linkTitle, linkUrl)
                      .then(async () => {
                        setLinkTitle('');
                        setLinkUrl('');
                        if (user?.id) setLinks(await getProfileLinks(user.id));
                      })
                      .catch(onError)
                  }
                />
              </>
            ) : null}
          </>
        ) : null}
        {/* --- Hidden words --- */}
        <ThemedText type="subtitle" style={styles.sectionTop}>
          Hidden words
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Comments on your posts containing these are hidden automatically (only you and the writer
          can see them). The built-in list of offensive terms is on by default.
        </ThemedText>
        <View style={styles.toggleRow}>
          <ThemedText type="small">Use the built-in list</ThemedText>
          <Switch
            value={useDefaults}
            onValueChange={(v) => {
              setUseDefaults(v);
              void setUseDefaultHiddenWords(v).catch(onError);
            }}
          />
        </View>
        <View style={styles.chips}>
          {words.map((w) => (
            <ThemedText
              key={w}
              type="small"
              style={[styles.chip, { borderColor: theme.border }]}
              onPress={() =>
                removeHiddenWord(w).then(() => setWords(words.filter((x) => x !== w)))
              }>
              {w} ✕
            </ThemedText>
          ))}
        </View>
        <TextField
          label=""
          placeholder="Add a word or phrase"
          value={newWord}
          onChangeText={setNewWord}
          maxLength={60}
        />
        <Button
          title="Add hidden word"
          variant="secondary"
          disabled={!newWord.trim()}
          onPress={() =>
            addHiddenWord(newWord)
              .then(() => {
                setWords([...words, newWord.trim().toLowerCase()].sort());
                setNewWord('');
              })
              .catch(onError)
          }
        />

        {/* --- Comment limits --- */}
        <ThemedText type="subtitle" style={styles.sectionTop}>
          Limit comments
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Temporarily restrict who can comment on your posts — useful during a pile-on.
        </ThemedText>
        {(
          [
            [null, 'Everyone'],
            ['followers', 'Followers only'],
            ['week_followers', 'People following you for over a week'],
          ] as const
        ).map(([value, label]) => (
          <View key={label} style={styles.toggleRow}>
            <ThemedText type="small">{label}</ThemedText>
            <Switch
              value={limit === value}
              onValueChange={() => {
                setLimit(value);
                void setCommentLimit(value as never).catch(onError);
              }}
            />
          </View>
        ))}

        {isBusiness ? (
          <>
            {/* --- Quick replies --- */}
            <ThemedText type="subtitle" style={styles.sectionTop}>
              Quick replies
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Saved answers you can insert in DMs and comment replies. Pasted quick replies earn
              little or no points — that&apos;s by design.
            </ThemedText>
            {replies.map((r) => (
              <View key={r.id} style={[styles.row, { borderColor: theme.border }]}>
                <View style={styles.rowBody}>
                  <ThemedText type="smallBold">/{r.shortcut}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                    {r.body}
                  </ThemedText>
                </View>
                <ThemedText
                  type="small"
                  style={{ color: BRAND.accent }}
                  onPress={() =>
                    deleteQuickReply(r.id).then(() =>
                      setReplies(replies.filter((x) => x.id !== r.id)),
                    )
                  }>
                  Delete
                </ThemedText>
              </View>
            ))}
            <TextField
              label=""
              placeholder="Shortcut (e.g. hours)"
              autoCapitalize="none"
              value={qrShortcut}
              onChangeText={setQrShortcut}
              maxLength={20}
            />
            <TextField
              label=""
              placeholder="Reply text"
              multiline
              value={qrBody}
              onChangeText={setQrBody}
              maxLength={500}
            />
            <Button
              title="Save quick reply"
              variant="secondary"
              disabled={!qrShortcut.trim() || !qrBody.trim()}
              onPress={() =>
                saveQuickReply(qrShortcut, qrBody)
                  .then(async () => {
                    setQrShortcut('');
                    setQrBody('');
                    setReplies(await getQuickReplies());
                  })
                  .catch(onError)
              }
            />
          </>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 48 },
  sectionTop: { marginTop: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  rowBody: { flex: 1, gap: 2 },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
});
