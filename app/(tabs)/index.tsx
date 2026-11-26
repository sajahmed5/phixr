import { ErrorBoundary } from '@/components/error-boundary';
import { TeenWellbeingBanner } from '@/components/teen-wellbeing-banner';
import { ThemedView } from '@/components/themed-view';
import { DeckView } from '@/components/deck/deck-view';
import { fetchDeck } from '@/lib/deck';

/** Home — the worldwide, ranked feed. Just the shared deck fed by the worldwide pool.
 * The phixr lockup lives in the tab's header (see (tabs)/_layout.tsx). */
export default function HomeScreen() {
  return (
    <ThemedView style={{ flex: 1 }}>
      {/* Gentle quiet-hours / screen-time nudges for under-18s (brief 6A). */}
      <TeenWellbeingBanner />
      {/* One-time GDPR/PECR ad-consent choice for adults (brief 8D). */}
      <ErrorBoundary label="The feed">
        <DeckView fetchBatch={fetchDeck} persistKey="home" />
      </ErrorBoundary>
    </ThemedView>
  );
}
