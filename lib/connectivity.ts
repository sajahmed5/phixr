import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * One place that knows whether the phone can reach the internet, and which kind of
 * connection it is on. Everything that works offline (the swipe queue, the message and
 * post outboxes, the deck's saved buffer, Wi-Fi-only video pre-download) reads from here.
 *
 * Development builds also get a "simulate offline" switch (Settings → Developer) that makes
 * the app behave exactly as if the signal had dropped: this module reports offline and every
 * Supabase request / pipeline upload fails like a network error. It does not exist in
 * production builds (`__DEV__` is false there).
 */

type Listener = (online: boolean) => void;

let netState: NetInfoState | null = null;
let netStateAt = 0;
// When a server last answered one of our requests. Proof of a working connection that
// beats NetInfo, which can get stuck on "no connection" (seen on the iOS simulator after
// the Mac slept, and possible on phones after network changes in the background).
let serverReachedAt = 0;
let simulatedOffline = false;
let lastOnline = true;
const listeners = new Set<Listener>();

function computeOnline(): boolean {
  if (simulatedOffline) return false;
  if (!netState) return true; // unknown at startup: assume online, requests will tell us
  // Only a definite "no connection" counts. NetInfo's separate reachability probe can
  // report false while requests actually work (captive networks, simulators, slow
  // probes) — and wrongly believing we're offline would hold back messages and posts
  // that could have been sent. Believing we're online when we're not only costs a
  // failed attempt that the queues retry.
  if (netState.isConnected !== false) return true;
  // NetInfo says no connection. Believe it, unless a server has answered since it said so.
  return serverReachedAt > netStateAt;
}

function emitIfChanged(): void {
  const online = computeOnline();
  if (online === lastOnline) return;
  lastOnline = online;
  for (const l of listeners) l(online);
}

NetInfo.addEventListener((state) => {
  netState = state;
  netStateAt = Date.now();
  emitIfChanged();
});

/**
 * Call when a request got ANY response from a server (even an error status): the
 * connection works, whatever NetInfo last reported. Flips the app back online (the banner
 * hides, the outboxes send) if NetInfo was stuck on offline.
 */
export function reportServerReached(): void {
  if (simulatedOffline) return;
  serverReachedAt = Date.now();
  emitIfChanged();
}

// Coming back to the foreground is a good moment to retry anything queued, even if the
// connection never visibly dropped (iOS may have suspended the app mid-request).
AppState.addEventListener('change', (s) => {
  if (s !== 'active') return;
  // Ask NetInfo to re-check rather than trusting a state from before the app slept.
  void NetInfo.refresh().catch(() => {});
  if (computeOnline()) for (const l of listeners) l(true);
});

export function isOnline(): boolean {
  return computeOnline();
}

/** True on Wi-Fi / Ethernet that isn't flagged as metered — safe to pre-download video. */
export function isUnmeteredConnection(): boolean {
  if (!computeOnline() || !netState) return false;
  const typeOk = netState.type === 'wifi' || netState.type === 'ethernet';
  const details = netState.details as { isConnectionExpensive?: boolean } | null;
  return typeOk && details?.isConnectionExpensive !== true;
}

/** Subscribe to online/offline changes. `cb(true)` also fires when the app returns to the
 *  foreground while online, so queues get a retry nudge. Returns an unsubscribe function. */
export function onConnectivityChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(computeOnline());
  useEffect(() => onConnectivityChange(setOnline), []);
  return online;
}

// ---- development-only offline simulation ----

export function isSimulatingOffline(): boolean {
  return __DEV__ && simulatedOffline;
}

const SIM_KEY = 'dev:simulate-offline';

export function setSimulatedOffline(on: boolean): void {
  if (!__DEV__) return;
  simulatedOffline = on;
  void AsyncStorage.setItem(SIM_KEY, on ? '1' : '0').catch(() => {});
  emitIfChanged();
}

// Development only: the switch survives a reload, so "open the app with no signal" can be
// tested. Read once at startup.
if (__DEV__) {
  void AsyncStorage.getItem(SIM_KEY)
    .then((v) => {
      if (v === '1') {
        simulatedOffline = true;
        emitIfChanged();
      }
    })
    .catch(() => {});
}

/** Thrown in place of a real request while offline is simulated. Looks like a dropped
 *  connection to every caller (no server error code). */
export class SimulatedNetworkError extends TypeError {
  constructor() {
    super('Network request failed');
  }
}

// ---- telling "no connection" apart from "the server said no" ----

type ErrorLike = { code?: unknown; message?: unknown; status?: unknown; name?: unknown };

/**
 * A permanent failure is one where the server answered and refused (a Postgres error such
 * as a foreign-key, permission or business-rule violation). Retrying it will never work,
 * so queues should drop or park the item instead of blocking everything behind it.
 * Everything else (no connection, timeouts, 5xx, an expired login mid-refresh) is
 * transient and worth retrying.
 */
export function isPermanentServerError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  // Postgres SQLSTATE: five characters. PostgREST's own codes start with PGRST (auth,
  // schema cache, timeouts) — treat those as transient.
  if (!/^[0-9A-Z]{5}$/.test(code)) return false;
  const cls = code.slice(0, 2);
  // Connection problems, resource limits, operator intervention, serialization/deadlock.
  if (['08', '53', '57', '58'].includes(cls)) return false;
  if (code === '40001' || code === '40P01') return false;
  return true;
}
