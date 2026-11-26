import { router } from 'expo-router';
import { Alert, Linking } from 'react-native';

import { postLink, profileLink } from '@/lib/share';

/**
 * Report reasons shared by every "Report" menu, plus what happens after a report is filed.
 *
 * The reason text is stored as-is in `reports.reason` and shown (and filterable) in the
 * admin moderation queue, so keep these wordings stable once released.
 */

export const REPORT_COPYRIGHT = 'Uses my work without permission';
export const REPORT_TRADEMARK = 'Misuses my brand or trade mark';
export const REPORT_IMPERSONATION = 'Pretending to be me or someone else';
export const REPORT_UNDER_13 = 'May be under 13';

/** Reasons offered when reporting a post (share sheet + post page). */
export const POST_REPORT_REASONS = [
  'Nudity or sexual content',
  'Violence or dangerous acts',
  'Harassment or bullying',
  'Hate speech or symbols',
  'Spam or scam',
  REPORT_COPYRIGHT,
  REPORT_TRADEMARK,
  'Something else',
] as const;

/** Reasons offered when reporting an account (profile ⋯ menu). */
export const ACCOUNT_REPORT_REASONS = [
  'Spam or scam',
  'Harassment or bullying',
  'Inappropriate content',
  REPORT_IMPERSONATION,
  REPORT_TRADEMARK,
  REPORT_UNDER_13,
  'Something else',
] as const;

const SUPPORT_EMAIL = 'support@joinphixr.com';

/** Which email the Copyright & IP policy asks for after an in-app flag, if any. */
function rightsSubject(reason: string): string | null {
  if (reason === REPORT_COPYRIGHT) return 'Copyright report';
  if (reason === REPORT_TRADEMARK) return 'Trade mark report';
  if (reason === REPORT_IMPERSONATION) return 'Impersonation report';
  return null;
}

type ReportedTarget = { kind: 'post'; id: string } | { kind: 'account'; handle: string };

/**
 * Confirmation shown once a report has been filed. Intellectual-property and
 * impersonation reports need proof we can't collect in a menu (who owns the work, proof
 * of identity), so those offer a pre-filled email, as the Copyright policy describes.
 */
export function confirmReported(reason: string, target: ReportedTarget): void {
  const subject = rightsSubject(reason);
  const what = target.kind === 'post' ? 'post' : 'account';
  if (!subject) {
    Alert.alert(
      'Thanks for reporting',
      reason === REPORT_UNDER_13
        ? "We'll review this account and remove it if it belongs to someone under 13."
        : `Our team will review this ${what}.`,
    );
    return;
  }
  const link = target.kind === 'post' ? postLink(target.id) : profileLink(target.handle);
  const goodFaith =
    'A statement that you believe in good faith the use is not authorised, and that the ' +
    'information in this report is accurate:\n';
  const body =
    `Link: ${link}\n\n` +
    (reason === REPORT_IMPERSONATION
      ? 'Who is being impersonated (you, or the person or business you act for):\n\n' +
        'How we can confirm your identity:\n'
      : reason === REPORT_TRADEMARK
        ? 'Your name and contact details:\n\n' +
          "The trade mark, where it's registered and the registration number:\n\n" +
          goodFaith
        : 'Your name and contact details:\n\n' +
          'The work being used, and where we can see the original:\n\n' +
          goodFaith);
  Alert.alert(
    "We've flagged this",
    reason === REPORT_IMPERSONATION
      ? "To act on impersonation we may need to confirm who you are. Email us with a few details and we'll take it from there."
      : reason === REPORT_TRADEMARK
        ? 'To complete the report, email us a few details about your trade mark, as set out in our Copyright & IP policy.'
        : 'To complete the report, email us a few details about your work, as set out in our Copyright & IP policy.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Read policy', onPress: () => router.push('/legal/copyright') },
      {
        text: 'Email us',
        onPress: () => {
          const url =
            `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}` +
            `&body=${encodeURIComponent(body)}`;
          Linking.openURL(url).catch(() =>
            Alert.alert(
              'No email app',
              `Email ${SUPPORT_EMAIL} with "${subject}" in the subject line.`,
            ),
          );
        },
      },
    ],
  );
}
