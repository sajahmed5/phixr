import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { LEGAL_DOCS, type LegalDocId } from '@/constants/legal';

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; lead: string | null; text: string }
  | { kind: 'bullet'; text: string };

// "3. YOUR CONTENT" — numbered, all-caps section heading (same rule as the public site).
const HEADING = /^\d+\.\s+[A-Z0-9 ,'’()&/‐-―-]+$/;

/** Turns the plain-text body into headings, paragraphs and bullet points. */
function parse(body: string): Block[] {
  const out: Block[] = [];
  for (const raw of body.split(/\n\n+/)) {
    const lines = raw.trim().split('\n');
    let rest: string[] = lines;
    if (HEADING.test(lines[0].trim())) {
      const h = lines[0].trim();
      // "3. YOUR CONTENT" → "3. Your content"
      const [num, ...words] = h.split(' ');
      const title = words.join(' ').toLowerCase();
      out.push({ kind: 'heading', text: `${num} ${title.charAt(0).toUpperCase()}${title.slice(1)}` });
      rest = lines.slice(1);
    }
    let para: string[] = [];
    const flush = () => {
      if (para.length === 0) return;
      const text = para.join(' ').trim();
      const m = text.match(/^([^—\n]{3,60})\s+—\s+([\s\S]+)$/);
      out.push(m ? { kind: 'para', lead: m[1], text: m[2] } : { kind: 'para', lead: null, text });
      para = [];
    };
    for (const line of rest) {
      const t = line.trim();
      if (t.startsWith('• ')) {
        flush();
        out.push({ kind: 'bullet', text: t.slice(2) });
      } else if (t) {
        para.push(t);
      }
    }
    flush();
  }
  return out;
}

/** Renders one legal document from constants/legal.ts (the list lives at /legal). */
export default function LegalScreen() {
  const { doc } = useLocalSearchParams<{ doc: string }>();
  const insets = useSafeAreaInsets();
  const entry = LEGAL_DOCS[doc as LegalDocId] ?? LEGAL_DOCS.terms;
  const blocks = useMemo(() => parse(entry.body), [entry.body]);

  return (
    <ThemedView style={styles.fill}>
      <Stack.Screen options={{ headerShown: true, title: entry.title }} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <ThemedText type="subtitle">{entry.title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.version}>
          Last updated {formatDate(entry.updated)}
        </ThemedText>
        {blocks.map((b, i) =>
          b.kind === 'heading' ? (
            <ThemedText key={i} type="smallBold" style={styles.heading} accessibilityRole="header">
              {b.text}
            </ThemedText>
          ) : b.kind === 'bullet' ? (
            <View key={i} style={styles.bulletRow}>
              <ThemedText type="default" style={styles.bulletDot}>
                •
              </ThemedText>
              <ThemedText type="default" style={styles.bulletText}>
                {b.text}
              </ThemedText>
            </View>
          ) : (
            <ThemedText key={i} type="default" style={styles.para}>
              {b.lead ? <ThemedText type="default" style={styles.lead}>{`${b.lead} — `}</ThemedText> : null}
              {b.text}
            </ThemedText>
          ),
        )}
      </ScrollView>
    </ThemedView>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 16 },
  version: { marginTop: 4, marginBottom: 12 },
  heading: { fontSize: 17, lineHeight: 22, marginTop: 22, marginBottom: 6 },
  para: { fontSize: 16, lineHeight: 24, marginBottom: 12 },
  lead: { fontSize: 16, lineHeight: 24, fontWeight: '700' },
  bulletRow: { flexDirection: 'row', gap: 8, marginBottom: 6, paddingLeft: 4 },
  bulletDot: { fontSize: 16, lineHeight: 24 },
  bulletText: { flex: 1, fontSize: 16, lineHeight: 24 },
});
