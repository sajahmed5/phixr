import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LocationField } from '@/components/compose/location-field';
import { ReportFab } from '@/components/report-issue';
import { TagPicker } from '@/components/compose/tag-picker';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { BRAND } from '@/constants/config';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth-context';
import { useOnline } from '@/lib/connectivity';
import { listGroups, type AudienceGroup } from '@/lib/groups';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  myActingBusinesses,
  saveBusinessDraft,
  scheduleBusinessDraft,
  type ActingBusiness,
} from '@/lib/business';
import { mediaFromPipeline, saveDraft, scheduleDraft, type DraftMedia, type DraftPayload } from '@/lib/drafts';
import { looksPromotional } from '@/lib/partnerships';
import { useUpload } from '@/lib/upload-manager';

const CAPTION_MAX = 2200;
const ALT_MAX = 1000;

export default function ComposeScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { composition, updateDraft, submit, retryUpload, clear, queueOffline } = useUpload();
  const { user, profile } = useAuth();
  const online = useOnline();
  const [groups, setGroups] = useState<AudienceGroup[] | null>(null);
  const [defaultApplied, setDefaultApplied] = useState(false);
  const [promoNudge, setPromoNudge] = useState(false);
  // Part 12A/12B: drafts + scheduling. Media must be pipeline-processed
  // (phase 'ready') before a draft can carry it.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [when, setWhen] = useState<Date>(() => new Date(Date.now() + 60 * 60 * 1000));
  // Part 13A: editors/admins can compose FOR a business. The post goes
  // through the business's drafts + scheduler and publishes server-side AS
  // the business — direct posting is disabled while acting.
  const [bizOptions, setBizOptions] = useState<ActingBusiness[]>([]);
  const [actingBiz, setActingBiz] = useState<ActingBusiness | null>(null);
  useEffect(() => {
    void myActingBusinesses(['admin', 'editor']).then(setBizOptions).catch(() => {});
  }, []);

  const buildPayload = useCallback((): DraftPayload | null => {
    const c = composition;
    if (!c?.result) return null;
    return {
      caption: c.draft.caption,
      alt_text: c.draft.altText,
      visibility: c.draft.visibility,
      group_ids: c.draft.groupIds,
      tags: c.draft.tags,
      attach_location: c.draft.attachLocation,
      location_cell: c.draft.locationCell ?? c.result.suggestions.location_cell ?? null,
      location_label: c.draft.locationLabel,
      partner_brand: c.draft.partnerBrand,
      overlays: c.overlays as unknown[],
      media: mediaFromPipeline([c.result, ...c.extraResults]),
    };
  }, [composition]);

  // Autosave (12A): once media is processed, keep a rolling server-side slot
  // so nothing is lost if the app closes. Debounced on edits. Skipped while
  // acting as a business (the draft belongs to the business, not to me).
  useEffect(() => {
    const payload = buildPayload();
    if (!payload || actingBiz || composition?.posting || composition?.postedId) return;
    const t = setTimeout(() => {
      saveDraft('post', payload, { autosave: true }).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, [buildPayload, actingBiz, composition?.posting, composition?.postedId]);

  const worstMediaStatus = (media: DraftMedia[]): string => {
    const order = ['approved', 'pending', 'flagged', 'removed'];
    let worst = 'approved';
    for (const m of media) {
      const s = m.moderation_status ?? 'approved';
      if (order.indexOf(s) > order.indexOf(worst)) worst = s;
    }
    return worst;
  };

  const onSaveDraft = async () => {
    // No connection: keep it on the phone; it lands in Drafts once the signal is back.
    if (composition?.phase === 'failed' && composition.uploadRetryable && !actingBiz) {
      queueOffline('draft');
      router.replace('/drafts');
      return;
    }
    const payload = buildPayload();
    if (!payload || savingDraft) return;
    setSavingDraft(true);
    try {
      if (actingBiz) {
        await saveBusinessDraft(
          actingBiz.business_id,
          payload as unknown as Record<string, unknown>,
          worstMediaStatus(payload.media),
        );
        clear();
        const { Alert } = await import('react-native');
        Alert.alert('Saved', `Saved to @${actingBiz.profiles?.handle ?? 'the business'}'s drafts.`);
        router.back();
        return;
      }
      await saveDraft('post', payload, draftId ? { id: draftId } : {});
      clear();
      router.replace('/drafts');
    } catch {
      setSavingDraft(false);
    }
  };

  const onSchedule = async (date: Date) => {
    const payload = buildPayload();
    if (!payload) return;
    setSavingDraft(true);
    try {
      if (actingBiz) {
        const id = await saveBusinessDraft(
          actingBiz.business_id,
          payload as unknown as Record<string, unknown>,
          worstMediaStatus(payload.media),
        );
        await scheduleBusinessDraft(actingBiz.business_id, id, date);
        clear();
        const { Alert } = await import('react-native');
        Alert.alert(
          'Scheduled',
          `Publishes as @${actingBiz.profiles?.handle ?? 'the business'} — it's in their schedule.`,
        );
        router.back();
        return;
      }
      const id = draftId ?? (await saveDraft('post', payload, {}));
      setDraftId(id);
      await saveDraft('post', payload, { id });
      await scheduleDraft(id, date);
      clear();
      router.replace('/schedule');
    } catch (e) {
      setSavingDraft(false);
      const { Alert } = await import('react-native');
      Alert.alert("Couldn't schedule", e instanceof Error ? e.message : 'Try again.');
    }
  };

  // Promotional-post prompt (brief 9C): nudge when the caption carries promo
  // wording or @mentions a business account. Debounced; best-effort.
  const captionText = composition?.draft.caption ?? '';
  useEffect(() => {
    if (!captionText.trim() || profile?.age_band === 'minor') {
      setPromoNudge(false);
      return;
    }
    const t = setTimeout(() => {
      void looksPromotional(captionText)
        .then(setPromoNudge)
        .catch(() => setPromoNudge(false));
    }, 600);
    return () => clearTimeout(t);
  }, [captionText, profile?.age_band]);

  // If there's no active composition (e.g. deep-linked), bounce back.
  useEffect(() => {
    if (!composition) router.back();
  }, [composition, router]);

  // Audience default (brief 4A): the user's LAST choice, except under-18s
  // always start on Followers. Groups re-default to the last-picked set only
  // if every group still exists.
  useEffect(() => {
    if (!composition || defaultApplied || !user?.id) return;
    setDefaultApplied(true);
    void (async () => {
      const gs = await listGroups().catch(() => [] as AudienceGroup[]);
      setGroups(gs);
      try {
        if (profile?.age_band === 'minor') {
          updateDraft({ visibility: 'private', groupIds: [] });
          return;
        }
        const raw = await AsyncStorage.getItem(`compose:last-audience:${user.id}`);
        if (!raw) return;
        const saved = JSON.parse(raw) as { visibility: string; groupIds: string[] };
        if (saved.visibility === 'groups') {
          const alive = saved.groupIds.filter((id) => gs.some((g) => g.id === id));
          if (alive.length > 0) updateDraft({ visibility: 'groups', groupIds: alive });
        } else if (saved.visibility === 'public' || saved.visibility === 'private') {
          updateDraft({ visibility: saved.visibility, groupIds: [] });
        }
      } catch {
        // defaults are a convenience, never a blocker
      }
    })();
  }, [composition, defaultApplied, user?.id, profile?.age_band, updateDraft]);

  const chooseAudience = useCallback(
    (visibility: 'public' | 'private' | 'groups', groupIds: string[]) => {
      updateDraft({ visibility, groupIds });
      if (user?.id) {
        void AsyncStorage.setItem(
          `compose:last-audience:${user.id}`,
          JSON.stringify({ visibility, groupIds }),
        ).catch(() => {});
      }
    },
    [updateDraft, user?.id],
  );
  // Once posted, leave for Home; the app-wide banner reports completion.
  useEffect(() => {
    if (composition?.postedId) router.replace('/');
  }, [composition?.postedId, router]);

  // Signal came back while the composer is still open after a no-connection failure:
  // pick the upload up again without making the user tap Retry.
  const waitingForSignal = composition?.phase === 'failed' && composition.uploadRetryable;
  useEffect(() => {
    if (waitingForSignal && online) retryUpload();
  }, [waitingForSignal, online, retryUpload]);

  if (!composition) return <ThemedView style={styles.fill} />;

  const { media, extras, draft, phase, progress, result, rejection, uploadError } = composition;
  const analysing = phase === 'uploading';
  const flagged = result?.moderation_status === 'flagged';
  // Upload couldn't start or finish for lack of signal: posting still works — it waits in
  // the outbox and goes up automatically.
  const offlineMode = phase === 'failed' && composition.uploadRetryable;
  const canPost =
    draft.tags.length > 0 &&
    phase !== 'rejected' &&
    !composition.posting &&
    (draft.visibility !== 'groups' || draft.groupIds.length > 0);

  function onPost() {
    if (!canPost) return;
    if (offlineMode) {
      queueOffline('post');
      router.replace('/');
      return;
    }
    submit();
    // Uploading or ready, posting continues in the background → go to the feed.
    router.replace('/');
  }

  function retake() {
    // Go straight back to the camera (not the deck). Navigate FIRST so the "composition
    // is null" guard effect doesn't also fire a router.back() and overshoot to Home.
    router.replace('/camera');
    clear();
  }

  return (
    <ThemedView style={styles.fill}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 96 }]}
          keyboardShouldPersistTaps="handled">
          {/* Preview */}
          <View style={styles.previewWrap}>
            {media.type === 'video' ? (
              <VideoPreview uri={media.uri} />
            ) : (
              <Image source={{ uri: media.uri }} style={styles.preview} contentFit="cover" />
            )}
            <Pressable style={styles.retake} onPress={retake} accessibilityRole="button">
              <Ionicons name="refresh" size={16} color="#fff" />
              <ThemedText type="small" style={styles.retakeText}>
                {media.type === 'video' ? 'Reshoot' : 'Retake'}
              </ThemedText>
            </Pressable>
            {extras.length > 0 ? (
              <View style={styles.countPill}>
                <Ionicons name="copy" size={12} color="#fff" />
                <ThemedText type="small" style={styles.retakeText}>{extras.length + 1}</ThemedText>
              </View>
            ) : null}
          </View>

          {/* Carousel strip: the cover + every extra, in posting order. */}
          {extras.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {[media, ...extras].map((m, i) => (
                <View key={`${m.uri}-${i}`}>
                  <Image source={{ uri: m.uri }} style={styles.stripThumb} contentFit="cover" />
                  {i === 0 ? (
                    <View style={styles.stripBadge}>
                      <ThemedText type="small" style={styles.retakeText}>Cover</ThemedText>
                    </View>
                  ) : null}
                </View>
              ))}
            </ScrollView>
          ) : null}

          {/* Upload progress / status */}
          <UploadStatus
            phase={phase}
            progress={progress}
            uploadError={uploadError}
            offline={offlineMode}
            onRetry={retryUpload}
            flagged={flagged}
          />

          {rejection ? <FormMessage tone="error">{rejection}</FormMessage> : null}

          {/* Caption */}
          <View>
            <TextField
              label="Caption"
              placeholder="Write a caption…"
              multiline
              value={draft.caption}
              maxLength={CAPTION_MAX}
              onChangeText={(t) => updateDraft({ caption: t })}
              style={styles.multiline}
            />
            <Counter value={draft.caption.length} max={CAPTION_MAX} />
          </View>

          {/* Alt text — optional but visible, not hidden in an advanced section */}
          <View>
            <TextField
              label="Alt text (optional)"
              placeholder="Describe the media for people using screen readers"
              multiline
              value={draft.altText}
              maxLength={ALT_MAX}
              onChangeText={(t) => updateDraft({ altText: t })}
              style={styles.multiline}
            />
            <Counter value={draft.altText.length} max={ALT_MAX} />
            {!draft.altText.trim() ? (
              <ThemedText type="small" themeColor="textSecondary">
                A line of alt text makes this post work for people using screen readers.
              </ThemedText>
            ) : null}
          </View>

          {/* Audience (brief 4A): Everyone / Followers / Groups, defaulting to the
              last choice (minors start on Followers). Group posts never enter the
              deck or search, and members see NO badge — the choice is the owner's
              secret. */}
          <View style={[styles.visRow, { borderColor: theme.border }]}>
            <ThemedText type="smallBold">Who can see this?</ThemedText>
            <View style={[styles.segment, { borderColor: theme.border }]}>
              <VisOption
                label="Everyone"
                icon="earth"
                active={draft.visibility === 'public'}
                onPress={() => chooseAudience('public', [])}
              />
              <VisOption
                label="Followers"
                icon="lock-closed"
                active={draft.visibility === 'private'}
                onPress={() => chooseAudience('private', [])}
              />
              <VisOption
                label="Groups"
                icon="people"
                active={draft.visibility === 'groups'}
                onPress={() =>
                  chooseAudience(
                    'groups',
                    draft.groupIds.length > 0
                      ? draft.groupIds
                      : groups && groups.length === 1
                        ? [groups[0].id]
                        : draft.groupIds,
                  )
                }
              />
            </View>
            {draft.visibility === 'groups' ? (
              groups === null ? null : groups.length === 0 ? (
                <View style={styles.groupHintRow}>
                  <ThemedText type="small" themeColor="textSecondary">
                    You haven&apos;t made any groups yet.
                  </ThemedText>
                  <Button
                    title="Create a group"
                    variant="secondary"
                    onPress={() => router.push('/settings/groups')}
                  />
                </View>
              ) : (
                <View style={styles.groupChips}>
                  {groups.map((g) => {
                    const on = draft.groupIds.includes(g.id);
                    return (
                      <Pressable
                        key={g.id}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        onPress={() =>
                          chooseAudience(
                            'groups',
                            on
                              ? draft.groupIds.filter((id) => id !== g.id)
                              : [...draft.groupIds, g.id],
                          )
                        }
                        style={[
                          styles.groupChip,
                          { borderColor: theme.border },
                          on && { backgroundColor: BRAND.accent, borderColor: BRAND.accent },
                        ]}>
                        <ThemedText
                          type="smallBold"
                          style={{ color: on ? BRAND.onAccent : theme.text }}>
                          {g.name}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              )
            ) : null}
            <ThemedText type="small" themeColor="textSecondary">
              {draft.visibility === 'public'
                ? 'Anyone can discover this in the deck.'
                : draft.visibility === 'private'
                  ? 'Only your accepted followers can see it.'
                  : draft.groupIds.length === 0
                    ? 'Pick at least one group.'
                    : 'Only people in the chosen groups can see it. They are never told a group exists.'}
            </ThemedText>
          </View>

          {/* Location — off by default. Uses the photo's GPS or the device's, then offers
              nearby places to tag; stores only a coarse area. */}
          <LocationField
            attachLocation={draft.attachLocation}
            label={draft.locationLabel}
            mediaGps={result?.suggestions.gps ?? null}
            onChange={(v) => updateDraft(v)}
          />

          {/* Tags */}
          <TagPicker
            analysing={analysing}
            visionSuggestions={(result?.suggestions.labels ?? []).map((l) => l.name)}
            geoSuggestions={(result?.suggestions.places ?? []).map((p) => p.name)}
            selected={draft.tags}
            onChange={(tags) => updateDraft({ tags })}
          />

          {/* Paid partnership (brief 9A/9C) — adults only; the label is permanent
              once posted (ASA disclosure), and the brand approves being named. */}
          {profile?.age_band !== 'minor' ? (
            <View>
              <ThemedText type="smallBold">Paid partnership</ThemedText>
              {promoNudge && !draft.partnerBrand ? (
                <FormMessage tone="error">
                  This looks promotional. If a brand paid you or gifted this, UK
                  advertising rules say it must be labelled — add the brand below.
                </FormMessage>
              ) : null}
              <TextField
                label=""
                placeholder="@brand — leave empty if this isn't paid"
                autoCapitalize="none"
                autoCorrect={false}
                value={draft.partnerBrand ?? ''}
                onChangeText={(t) => updateDraft({ partnerBrand: t || null })}
              />
              <ThemedText type="small" themeColor="textSecondary">
                Adds a permanent “Paid partnership” label to this post. The brand
                (a Phixr business account) is asked to approve being named.
              </ThemedText>
            </View>
          ) : null}
        </ScrollView>

        {/* Post bar */}
        <View
          style={[
            styles.postBar,
            {
              paddingBottom: insets.bottom + 12,
              borderTopColor: theme.border,
              backgroundColor: theme.background,
            },
          ]}>
          {bizOptions.length > 0 ? (
            <View style={styles.postAsRow}>
              <ThemedText type="small" themeColor="textSecondary">
                Post as
              </ThemedText>
              {[null, ...bizOptions].map((b) => {
                const on = (b?.business_id ?? null) === (actingBiz?.business_id ?? null);
                return (
                  <Pressable
                    key={b?.business_id ?? 'me'}
                    accessibilityRole="button"
                    onPress={() => setActingBiz(b)}
                    style={[
                      styles.postAsChip,
                      { borderColor: on ? BRAND.accent : theme.border },
                    ]}>
                    <ThemedText type="small">
                      {b ? `@${b.profiles?.handle ?? 'business'}` : 'Me'}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {actingBiz ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              Business posts publish through their schedule — save a draft or schedule below.
            </ThemedText>
          ) : (
            <Button
              title={
                offlineMode ? 'Post when back online' : phase === 'uploading' ? 'Post when ready' : 'Post'
              }
              onPress={onPost}
              disabled={!canPost}
              loading={composition.posting}
            />
          )}
          <View style={styles.draftRow}>
            <Button
              title="Save draft"
              variant="secondary"
              onPress={onSaveDraft}
              disabled={
                savingDraft || (offlineMode ? !!actingBiz : phase !== 'ready')
              }
            />
            <Button
              title="Schedule…"
              variant="secondary"
              onPress={() => setPickerOpen(true)}
              disabled={!canPost || phase !== 'ready' || savingDraft}
            />
          </View>
          {pickerOpen ? (
            <View>
              <DateTimePicker
                value={when}
                mode="datetime"
                minimumDate={new Date()}
                onChange={(_e, d) => {
                  if (d) setWhen(d);
                }}
              />
              <View style={styles.draftRow}>
                <Button title="Confirm schedule" onPress={() => void onSchedule(when)} disabled={savingDraft} />
                <Button title="Cancel" variant="secondary" onPress={() => setPickerOpen(false)} />
              </View>
            </View>
          ) : null}
          {flagged ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              This post will be reviewed before it appears to others.
            </ThemedText>
          ) : null}
        </View>
      </KeyboardAvoidingView>
      {/* This route is presented as a modal, which iOS puts in its own container —
          the app-wide button can't reach it. */}
      <ReportFab />
    </ThemedView>
  );
}

function UploadStatus({
  phase,
  progress,
  uploadError,
  offline,
  onRetry,
  flagged,
}: {
  phase: string;
  progress: number;
  uploadError: string | null;
  offline: boolean;
  onRetry: () => void;
  flagged: boolean;
}) {
  const theme = useTheme();
  if (phase === 'failed' && offline) {
    return (
      <View style={styles.statusRow}>
        <Ionicons name="cloud-offline-outline" size={18} color={theme.textSecondary} />
        <ThemedText type="small" themeColor="textSecondary" style={{ flex: 1 }}>
          No connection. You can still post — it&apos;s saved on your phone and goes up
          automatically when you&apos;re back online.
        </ThemedText>
      </View>
    );
  }
  if (phase === 'failed') {
    return (
      <View style={styles.statusRow}>
        <FormMessage tone="error">{uploadError ?? 'Upload failed.'}</FormMessage>
        <Button title="Retry upload" variant="secondary" onPress={onRetry} />
      </View>
    );
  }
  if (phase === 'uploading') {
    return (
      <View style={styles.uploadWrap}>
        <View style={[styles.progressTrack, { backgroundColor: theme.backgroundSelected }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round(progress * 100)}%`, backgroundColor: BRAND.accent },
            ]}
          />
        </View>
        <ThemedText type="small" themeColor="textSecondary">
          Uploading… {Math.round(progress * 100)}%
        </ThemedText>
      </View>
    );
  }
  if (phase === 'ready') {
    return (
      <View style={styles.statusRow}>
        <Ionicons
          name="checkmark-circle"
          size={18}
          color={flagged ? theme.textSecondary : '#2E7D46'}
        />
        <ThemedText type="small" themeColor="textSecondary">
          {flagged
            ? 'Uploaded — will be reviewed before others see it.'
            : 'Uploaded and ready to post.'}
        </ThemedText>
      </View>
    );
  }
  return null;
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <ThemedText
      type="small"
      themeColor={value > max * 0.95 ? 'danger' : 'textSecondary'}
      style={styles.counter}>
      {value}/{max}
    </ThemedText>
  );
}

function VisOption({
  label,
  icon,
  active,
  onPress,
}: {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.segOption, active && { backgroundColor: BRAND.accent }]}>
      <Ionicons name={icon} size={16} color={active ? BRAND.onAccent : theme.text} />
      <ThemedText type="smallBold" style={{ color: active ? BRAND.onAccent : theme.text }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  // Native controls + no autoplay so it's playable/scrubbable (autoplay-with-no-controls
  // left it black with no way to start it). 'contain' avoids cropping the frame to black.
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true;
    p.muted = false;
  });
  return (
    <VideoView player={player} style={styles.preview} contentFit="contain" nativeControls />
  );
}

const styles = StyleSheet.create({
  draftRow: { flexDirection: 'row', gap: 10, justifyContent: 'center', marginTop: 8 },
  postAsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  postAsChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  fill: { flex: 1 },
  content: { padding: 16, gap: 18 },
  previewWrap: { borderRadius: 16, overflow: 'hidden' },
  countPill: { position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  strip: { flexDirection: 'row', gap: 8, paddingVertical: 10 },
  stripThumb: { width: 64, height: 64, borderRadius: 10, backgroundColor: '#000' },
  stripBadge: { position: 'absolute', bottom: 4, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.65)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  preview: { width: '100%', aspectRatio: 4 / 5, backgroundColor: '#000' },
  retake: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  retakeText: { color: '#fff' },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', marginTop: 4 },
  visRow: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 10 },
  groupHintRow: { gap: 8 },
  groupChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  groupChip: {
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  segment: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: 'hidden',
  },
  segOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  uploadWrap: { gap: 6 },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  postBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  center: { textAlign: 'center' },
});
