import type { HugoTier } from '@alto-people/shared';
import { detectHugoIntent, normalizeHugoText, type HugoContext, type HugoIntentKey } from './hugo.js';

/**
 * Which way a question goes, cheapest and quickest first (docs/hugo-speed.md):
 *
 *   instant  the registry answers it outright, no model: a suggestion
 *            tapped, or a worker's short question about their own payday,
 *            shifts, ride or documents with nothing in it that needs judgment
 *   deep     an action to set up or numbers to run: the strongest model
 *   fast     everything else: a quick model
 *
 * The registry matches loosely ("work" reaches the schedule), so the
 * instant path is narrow on purpose: a worker's own records, a few words,
 * and no word that turns a lookup into a question of judgment ("why",
 * "wrong", "didn't", "how much", "swap"…). A desk's questions name other
 * people and sites, so only its tapped suggestions are instant.
 */

/** Answers about the person's own records, which the registry gives whole. */
const SELF_SERVE: ReadonlySet<HugoIntentKey> = new Set(['PAYDAY', 'SCHEDULE', 'RIDE', 'RENEW', 'DRIVER_NEXT_RUN', 'DRIVER_RUN_RIDERS', 'DRIVER_VAN_ISSUE', 'WHO']);
/** A suggestion a desk taps: the registry's list is the answer. */
const TAPPED: ReadonlySet<HugoIntentKey> = new Set([...SELF_SERVE, 'DESK', 'COVERAGE']);
const MAX_INSTANT_WORDS = 7;

/** Lower case, no accents or apostrophes ("didn't" → "didnt"), punctuation to spaces. */
export function routingText(s: string): string {
  return normalizeHugoText(s)
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words that make a lookup a judgment: a complaint, a comparison, a change, a what-if. */
const JUDGMENT =
  /\b(not|no|never|dont|didnt|doesnt|isnt|wasnt|arent|cant|wont|havent|hasnt|wrong|missing|why|how much|how many|less|more|extra|change\w*|cancel\w*|swap\w*|cover\w*|trade|late|early|problem|issue|error|mistake|short|overtime|tax\w*|deduct\w*|owe\w*|can i|could i|should i|if|but|instead|other|someone|somebody|coworker|nunca|por que|porque|mal|falta\w*|cambi\w*|cuant\w*|tarde|problema|debo|puedo|mas|otro|otra|neden|niye|yanlis|eksik|degil|iptal|degis\w*|kac|gec|sorun|hata|borc\w*|baska)\b/;

export function instantIntent(text: string, ctx: HugoContext, examples: ReadonlyArray<{ key: string; example: string }>): HugoIntentKey | null {
  const asked = routingText(text);
  if (!asked) return null;
  // A suggestion tapped: the registry's own question, answered by the registry.
  const tapped = examples.find((e) => routingText(e.example) === asked);
  if (tapped) return TAPPED.has(tapped.key as HugoIntentKey) ? (tapped.key as HugoIntentKey) : null;
  if (ctx.audience !== 'associate' && ctx.audience !== 'driver') return null;
  if (asked.split(' ').length > MAX_INSTANT_WORDS || JUDGMENT.test(asked)) return null;
  const { intent } = detectHugoIntent(text, ctx);
  return SELF_SERVE.has(intent) ? intent : null;
}

/** Setting something up for the person to confirm. */
const ACTION =
  /\b(approve\w*|deny|reject\w*|decline\w*|assign\w*|give|send|message|text|notify|file|request\w*|swap\w*|call out|call off|cancel\w*|move|book|aprob\w*|rechaz\w*|asign\w*|envi\w*|mand\w*|solicit\w*|onay\w*|redd\w*|ata\w*|gonder\w*|iptal|iste\w*)\b/;
/** Counting, totalling, comparing: a report. */
const NUMBERS =
  /\b(how many|how much|total\w*|by (month|week|day|site|store|client|location|status)|per (month|week|day|site|store)|compar\w*|trend\w*|report\w*|average|breakdown|most|least|top \d+|cuant\w*|promedio|tendencia|informe|kac|toplam|ortalama|karsilastir\w*|rapor\w*)\b/;

export function pickTier(text: string, opts: { canPropose: boolean; canReport: boolean }): Exclude<HugoTier, 'instant'> {
  const asked = routingText(text);
  if (opts.canPropose && ACTION.test(asked)) return 'deep';
  if (opts.canReport && NUMBERS.test(asked)) return 'deep';
  // Several questions at once, or a long story: worth the stronger model.
  if (text.length > 280 || (text.match(/\?/g) ?? []).length > 1) return 'deep';
  return 'fast';
}
