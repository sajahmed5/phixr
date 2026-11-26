import * as Linking from 'expo-linking';

/**
 * The most recent link that opened the app while it was already running.
 *
 * A screen that a link navigates to mounts AFTER the link event has fired, so
 * Linking.useURL() inside that screen still reports the app's launch URL. That loses
 * the URL fragment the password-reset email relies on (#access_token=…). Listening here,
 * from a module the root layout imports at startup, means the latest link is always kept.
 */
let latest: string | null = null;

Linking.addEventListener('url', ({ url }) => {
  latest = url;
});

export function latestIncomingUrl(): string | null {
  return latest;
}
