// English for the pages that use 'ai.*' keys — imported by them (scripts/i18n-check.mjs checks it).
import { registerEnglish } from '../english';

export const enAi = {
  // Accept-invite (the first screen a new hire ever sees)
  'ai.tagline': 'Welcome aboard',
  'ai.hidePassword': 'Hide password',
  'ai.showPassword': 'Show password',
  'ai.missingToken': 'Missing invitation token.',
  'ai.invalidOrExpired': 'This invitation has expired or was already used.',
  'ai.loadFailed': 'Could not load invitation.',
  'ai.alreadyActive': 'This account is already active. Try signing in instead.',
  'ai.expired': 'This invitation has expired or was already used.',
  'ai.acceptFailed': 'Could not accept invitation.',
  'ai.problemTitle': 'Need a new invitation link?',
  'ai.renewSent': 'If that email has a pending invitation, a fresh link is on its way.',
  'ai.renewIntro': "Enter your email and we'll send you a fresh invitation link.",
  'ai.emailLabel': 'Email',
  'ai.sending': 'Sending…',
  'ai.sendNewLink': 'Send me a new link',
  'ai.or': 'or',
  'ai.goToSignIn': 'Go to sign in',
  'ai.welcome': 'Welcome',
  'ai.welcomeName': 'Welcome, {name}',
  'ai.setPasswordIntro': 'Set a password to access your onboarding tasks.',
  'ai.passwordLabel': 'Password',
  'ai.strengthStrong': 'Strength: strong.',
  'ai.strengthOk': 'Strength: ok — mix upper and lower case with a number to make it strong.',
  'ai.minChars': 'Minimum 12 characters.',
  'ai.settingUp': 'Setting up…',
  'ai.setPasswordCta': 'Set password & sign in',
  'ai.linkExpires': 'This link expires {when}.',
} as const;

registerEnglish(enAi);
