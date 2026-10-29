import { enCore } from './en/core';

/**
 * The English the app has loaded so far: the core pack from the start,
 * then each area pack as the first page that needs it loads (it calls
 * registerEnglish when its module runs — before that page renders).
 *
 * English used to be one 283 KB object in the main bundle (82 KB gz, 42% of
 * it) on every page; a phone sweep on 2026-10-24 found it the largest
 * single cost of a first load for every role.
 */
export const en: Record<string, string> = { ...enCore };

export function registerEnglish(pack: Record<string, string>): void {
  Object.assign(en, pack);
}

/**
 * Translations a page brings with it (2026-10-28). Most of a language loads
 * as one lazy pack (i18n.tsx PACK_LOADERS); an area only one audience reads —
 * the executive portal — keeps its translations beside its English, in the
 * page's own chunk, so a Spanish-reading associate never downloads the
 * chairman's strings. Looked up after the language pack (i18n.tsx t()).
 */
export const pageTranslations: Record<string, Record<string, string>> = {};

export function registerTranslations(lang: string, pack: Record<string, string>): void {
  pageTranslations[lang] = Object.assign(pageTranslations[lang] ?? {}, pack);
}
