import { useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth';
import { isLang, useI18n } from '@/lib/i18n';
import { updateLanguage } from '@/lib/settingsApi';

/**
 * Keeps the app's language toggle and the account's email language in step.
 *
 * At sign-in the account's stored preference wins (a person who chose
 * Spanish on their phone gets Spanish on the kiosk too). After that, every
 * toggle writes the choice back, so the emails Alto sends follow the
 * language the person reads the app in. Turkish is an email-only choice
 * (the UI has no Turkish strings), so it never overrides the UI language.
 */
export function LanguageSync() {
  const { user } = useAuth();
  const { lang, setLang } = useI18n();
  const appliedFor = useRef<string | null>(null);
  const lastSynced = useRef<string | null>(null);

  // Server → local, once per signed-in account.
  useEffect(() => {
    if (!user) {
      appliedFor.current = null;
      lastSynced.current = null;
      return;
    }
    if (appliedFor.current === user.id) return;
    appliedFor.current = user.id;
    lastSynced.current = user.language ?? null;
    const stored = user.language;
    if (isLang(stored) && stored !== lang) setLang(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the account changes, not on every toggle
  }, [user?.id]);

  // Local → server, on every toggle after that.
  useEffect(() => {
    if (!user || appliedFor.current !== user.id) return;
    if (lastSynced.current === lang) return;
    lastSynced.current = lang;
    // The account language (emails, WhatsApp) speaks EN/ES/TR; the app
    // speaks three more. A choice the server cannot hold stays local.
    if (lang !== 'en' && lang !== 'es' && lang !== 'tr') return;
    void updateLanguage(lang).catch(() => {
      /* best effort — the local choice still applies */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- user identity is checked through the ref
  }, [lang]);

  return null;
}
