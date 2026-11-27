// ============================================================================
// tag-rules.ts — admin-tuned clean-up of vision suggestions.
//
// public.tag_label_rules (edited in fame-admin) says which labels to DROP and
// which to RENAME ("canidae" → "dog"). Rules are cached per isolate for
// TAG_RULES_CACHE_SECONDS so an upload never waits on more than one read.
// If the table can't be read, suggestions go out with only the built-in
// generic filter (vision.ts) — never an upload failure over tag polish.
// ============================================================================
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { config } from './config.ts';
import type { LabelSuggestion } from './vision.ts';

type Rules = { drop: Set<string>; rename: Map<string, string> };

let cache: { rules: Rules; at: number } | null = null;

async function loadRules(svc: SupabaseClient): Promise<Rules> {
  const ttlMs = config.tagging.tagRulesCacheSeconds * 1000;
  if (cache && Date.now() - cache.at < ttlMs) return cache.rules;
  const rules: Rules = { drop: new Set(), rename: new Map() };
  const { data, error } = await svc
    .from('tag_label_rules')
    .select('label, action, rename_to')
    .eq('active', true);
  if (error) {
    console.warn('[media-pipeline] tag rules unavailable:', error.message);
    return cache?.rules ?? rules; // keep the last good set if we had one
  }
  for (const r of (data ?? []) as { label: string; action: string; rename_to: string | null }[]) {
    if (r.action === 'drop') rules.drop.add(r.label);
    else if (r.action === 'rename' && r.rename_to) rules.rename.set(r.label, r.rename_to);
  }
  cache = { rules, at: Date.now() };
  return rules;
}

/**
 * Landmarks first (a named place beats a generic label), then labels by
 * confidence. Drop/rename per the rules, dedupe on the final name keeping the
 * first (highest-priority) occurrence, cap at LABEL_MAX_SUGGESTIONS.
 */
export async function applyTagRules(
  svc: SupabaseClient,
  landmarks: LabelSuggestion[],
  labels: LabelSuggestion[],
): Promise<LabelSuggestion[]> {
  const rules = await loadRules(svc);
  const seen = new Set<string>();
  const out: LabelSuggestion[] = [];
  for (const l of [...landmarks, ...labels]) {
    if (rules.drop.has(l.name)) continue;
    const name = rules.rename.get(l.name) ?? l.name;
    if (rules.drop.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, confidence: l.confidence });
    if (out.length >= config.tagging.labelMaxSuggestions) break;
  }
  return out;
}
