import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Hand-rolled i18n — deliberately not a library. The needs are small
 * (two languages, flat string keys, {name} interpolation) and every
 * i18n dependency drags in pluralization engines, ICU parsers, and a
 * runtime we'd ship to every phone. The dictionary lives in this chunk;
 * missing es keys fall back to en, and a missing key renders the key
 * itself so it's findable in QA instead of blank.
 *
 * Spanish first because it's the workforce's dominant second language;
 * the associate-facing core (tab bar, dashboard, schedule) is the
 * translated slice — admin surfaces stay English for now.
 */

export type Lang = 'en' | 'es' | 'tr' | 'ht' | 'pt' | 'uk';
/**
 * Every language the app speaks, in the order the pickers list them. The
 * first three are reviewed; Haitian Creole, Portuguese and Ukrainian (Brief
 * 3-6, the next three by workforce count) are machine-drafted and marked
 * for review in docs/scale-investigation.md. The associate app is complete
 * in all six; admin-only strings stay English outside EN/ES.
 */
export const LANGS: readonly Lang[] = ['en', 'es', 'tr', 'ht', 'pt', 'uk'];
export const LANG_LABELS: Record<Lang, string> = {
  en: 'English',
  es: 'Español',
  tr: 'Türkçe',
  ht: 'Kreyòl ayisyen',
  pt: 'Português',
  uk: 'Українська',
};
export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

import { defaultTenantProfile, termsIn, type TermKey } from '@alto-people/shared';
import { en } from './i18n/english';
import type { EnglishKey } from './i18n/en/keys';

const STORAGE_KEY = 'alto.lang';



export type MessageKey = EnglishKey;


// The three later languages and the rest of Turkish live in their own
// modules (the associate app's keys, generated from reviewed chunks); the
// hand-written Turkish lines above win where they overlap.
/** English is the only language bundled with the app; every other one is a pack below. */
const MESSAGES: Partial<Record<Lang, Partial<Record<MessageKey, string>>>> = {
  en,
};

/**
 * Every language but English loads when a person picks it — or, for the
 * language they last used, before first paint (preloadSavedLanguage in
 * main.tsx), so nobody sees a flash of English. Shipping Spanish and
 * Turkish inline cost every English reader ~75 KB gzip before first paint.
 * Tests preload every pack in test/setup.ts, so t() stays synchronous there.
 */
const PACK_LOADERS: Partial<Record<Lang, () => Promise<Partial<Record<MessageKey, string>>>>> = {
  es: () => import('./i18n/es').then((m) => m.es),
  tr: () => Promise.all([import('./i18n/tr'), import('./i18n/trStaff')]).then(([a, b]) => ({ ...a.tr, ...b.tr })),
  ht: () => import('./i18n/ht').then((m) => m.ht),
  pt: () => import('./i18n/pt').then((m) => m.pt),
  uk: () => import('./i18n/uk').then((m) => m.uk),
};
const packCache = new Map<Lang, Partial<Record<MessageKey, string>>>();

/** Load a language pack ahead of time (tests, or a picker that wants no flash of English). */
/** Before first paint: load the language this person last used (or their browser's), so the first screen is already in it. */
export function preloadSavedLanguage(): Promise<void> {
  return loadLanguagePack(detectLang()).catch(() => undefined);
}

export async function loadLanguagePack(lang: Lang): Promise<void> {
  const loader = PACK_LOADERS[lang];
  if (!loader || packCache.has(lang)) return;
  packCache.set(lang, await loader());
}

/**
 * The tenant's words, available to every string as {worker} {workers}
 * {site} {sites} {manager} {managers} {client} {clients} and their
 * lower-case forms ({workerLc} …). The AuthProvider sets them from the
 * tenant profile in the current language; the defaults are Alto HR's.
 */
export type TermVars = Record<string, string>;
export const DEFAULT_TERM_VARS: TermVars = termVarsFrom(termsIn(defaultTenantProfile('WORKFORCE_PROVIDER'), 'en'));

/**
 * The tenant's words as `{worker}`, `{site}` … and its name as `{org}`
 * (F500 G5): a client of another staffing company reads that company's
 * name on the portal ("Your {org} lead"), never "Alto".
 */
export function termVarsFrom(terms: Record<TermKey, string>, opts: { org?: string | null } = {}): TermVars {
  const lc = (v: string) => v.charAt(0).toLowerCase() + v.slice(1);
  const vars: TermVars = {
    worker: terms.worker,
    workers: terms.workers,
    site: terms.site,
    sites: terms.sites,
    manager: terms.manager,
    managers: terms.managers,
    client: terms['label.client'],
    clients: terms['label.clients'],
  };
  for (const [k, v] of Object.entries({ ...vars })) vars[`${k}Lc`] = lc(v);
  // A name is not lower-cased: no {orgLc}.
  // The fallback is the API's own default branding (lib/branding DEFAULT_BRANDING), inlined: this runs at module load.
  vars.org = opts.org?.trim() || 'Alto HR';
  return vars;
}

function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLang(stored)) return stored;
    const nav = navigator.language?.toLowerCase() ?? '';
    const match = LANGS.find((l) => l !== 'en' && nav.startsWith(l));
    return match ?? 'en';
  } catch {
    return 'en';
  }
}

function format(template: string, vars: Record<string, string | number> | undefined, terms: TermVars): string {
  if (!vars && !template.includes('{')) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars && k in vars ? String(vars[k]) : k in terms ? terms[k]! : `{${k}}`,
  );
}

/**
 * Plurals, without an ICU engine. `t('portal.storesCount', { count })`:
 *   - count 0 reads `<key>_zero` when it exists ("No stores yet" — a zero
 *     said in words, not "0 stores");
 *   - otherwise the language's plural rule picks the category, and a
 *     `<key>_one` / `_few` / `_many` variant is used when it exists;
 *   - else the base key, which is the "other" form ("{count} stores").
 * So a key with no variants behaves exactly as before, and adding
 * `<key>_one` next to it is all "1 stores" ever needed. A language is
 * resolved on its own first: a pack that has the base but no variant keeps
 * its own words rather than borrowing English's variant.
 */
const PLURAL_RULES = new Map<string, Intl.PluralRules>();
function pluralCategory(lang: Lang, n: number): string {
  let rules = PLURAL_RULES.get(lang);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(lang);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    PLURAL_RULES.set(lang, rules);
  }
  return rules.select(n);
}

type Lookup = (key: string) => string | undefined;

function resolveMessage(lang: Lang, own: Lookup, key: MessageKey, vars: Record<string, string | number> | undefined): string {
  const english: Lookup = (k) => (en as Record<string, string>)[k];
  const count = vars?.count;
  if (typeof count === 'number' && Number.isFinite(count)) {
    const variant = (dict: Lookup, rulesLang: Lang): string | undefined =>
      (count === 0 ? dict(`${key}_zero`) : undefined) ?? dict(`${key}_${pluralCategory(rulesLang, count)}`);
    const mine = variant(own, lang);
    if (mine !== undefined) return mine;
    if (own(key) === undefined) {
      const fallback = variant(english, 'en');
      if (fallback !== undefined) return fallback;
    }
  }
  return own(key) ?? english(key) ?? key;
}

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
  /** The tenant's words in the current language (Brief 2-1b); the AuthProvider keeps them current. */
  setTermVars: (vars: TermVars) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [termVars, setTermVarsState] = useState<TermVars>(DEFAULT_TERM_VARS);
  // Bumped when a lazy pack lands so t() re-renders in the chosen language.
  const [packVersion, setPackVersion] = useState(0);
  useEffect(() => {
    if (!PACK_LOADERS[lang] || packCache.has(lang)) return;
    let cancelled = false;
    // A code chunk, not data: the query layer has no business caching a language pack.
    // eslint-disable-next-line no-restricted-syntax
    void loadLanguagePack(lang).then(() => {
      if (!cancelled) setPackVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [lang]);
  const setTermVars = useCallback((vars: TermVars) => {
    setTermVarsState((prev) => (shallowEqual(prev, vars) ? prev : vars));
  }, []);

  useEffect(() => {
    // Keep <html lang> honest for screen readers and hyphenation.
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the choice just doesn't persist.
    }
  }, []);

  const t = useCallback<Translate>(
    (key, vars) =>
      format(
        resolveMessage(lang, (k) => packCache.get(lang)?.[k as MessageKey] ?? MESSAGES[lang]?.[k as MessageKey], key, vars),
        vars,
        termVars,
      ),
    // packVersion is the signal that a lazy pack arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, termVars, packVersion],
  );

  const value = useMemo(() => ({ lang, setLang, t, setTermVars }), [lang, setLang, t, setTermVars]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function shallowEqual(a: TermVars, b: TermVars): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

const FALLBACK: I18nContextValue = {
  lang: 'en',
  setLang: () => {},
  t: (key, vars) => format(resolveMessage('en', (k) => (en as Record<string, string>)[k], key, vars), vars, DEFAULT_TERM_VARS),
  setTermVars: () => {},
};

/** Works without a provider (English) so isolated component tests and
 *  storybook-style renders don't need wrapping. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? FALLBACK;
}
