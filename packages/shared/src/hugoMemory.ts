import { z } from 'zod';
import { findSensitiveNumbers } from './sensitiveText.js';
import { patchSchema } from './zodPatch.js';

/**
 * What Hugo knows (Muse phase 4, 2026-10-29): short facts a person told the
 * assistant about themselves — "I prefer mornings", "I take the 6:10 van
 * from Main St" — kept so he can help better next time, and shown to them in
 * "What Hugo knows", where every one can be read, changed and removed.
 *
 * Privacy first. He keeps only facts about the person, in their own words,
 * at most 200 characters, at most 50 of them, and never:
 *   - ID, Social Security, bank or card numbers, passwords or contact details;
 *   - health, medical, pregnancy or disability;
 *   - religion;
 *   - immigration or visa status;
 *   - sexual orientation or gender identity;
 *   - a criminal record;
 *   - union membership;
 *   - anything about another person.
 * `checkHugoMemoryText` is the one guard every save goes through, on the
 * server (lib/hugoMemory) and, as the person types, in the app. Keyword
 * lists cover the six languages associates read (en es tr ht pt uk); the
 * model is told the same rules (the remember tool's description).
 */

export const HUGO_MEMORY_KINDS = ['PREFERENCE', 'AVAILABILITY', 'TRAVEL', 'WORK', 'OTHER'] as const;
export type HugoMemoryKind = (typeof HUGO_MEMORY_KINDS)[number];

/** TOLD: said in a chat, Hugo saved it. ADDED: the person typed it in What Hugo knows. */
export const HUGO_MEMORY_SOURCES = ['TOLD', 'ADDED'] as const;
export type HugoMemorySource = (typeof HUGO_MEMORY_SOURCES)[number];

/** How many facts one person can keep. */
export const HUGO_MEMORY_MAX = 50;
/** How long one fact can be. */
export const HUGO_MEMORY_TEXT_MAX = 200;

/**
 * Why a fact was not kept. The app words each one (hugoPane.memory.refused.*);
 * the model is told in English and says it in the person's language.
 */
export const HUGO_MEMORY_REFUSALS = [
  'EMPTY',
  'TOO_LONG',
  'SECRET',
  'HEALTH',
  'RELIGION',
  'IMMIGRATION',
  'ORIENTATION',
  'CRIMINAL',
  'UNION',
  'OTHER_PERSON',
  'FULL',
  'OFF',
] as const;
export type HugoMemoryRefusal = (typeof HUGO_MEMORY_REFUSALS)[number];

export interface HugoMemoryView {
  id: string;
  kind: HugoMemoryKind;
  text: string;
  source: HugoMemorySource;
  createdAt: string;
  updatedAt: string;
  /** The last time it was in front of the model (null: not used yet). */
  lastUsedAt: string | null;
}

export interface HugoMemoryListResponse {
  /** Off: Hugo neither uses nor saves anything; what is kept stays until removed. */
  memoryOn: boolean;
  /** Most recent first. */
  facts: HugoMemoryView[];
  max: number;
}

/** What an answer saved (the chip under it: "Saved to what Hugo knows · Undo"). */
export interface HugoRemembered {
  id: string;
  text: string;
}

export const HugoMemoryInputSchema = /* @__PURE__ */ (() =>
  z.object({ text: z.string().trim().min(1).max(HUGO_MEMORY_TEXT_MAX), kind: z.enum(HUGO_MEMORY_KINDS).default('OTHER') }))();
export type HugoMemoryInput = z.input<typeof HugoMemoryInputSchema>;

export const HugoMemoryPatchSchema = /* @__PURE__ */ (() =>
  patchSchema(HugoMemoryInputSchema).refine((v) => v.text !== undefined || v.kind !== undefined, { message: 'Nothing to change.' }))();
export type HugoMemoryPatch = z.input<typeof HugoMemoryPatchSchema>;

export const HugoMemorySettingsInputSchema = /* @__PURE__ */ (() => z.object({ memoryOn: z.boolean() }))();

/* ------------------------------------------------------------------ guard */

/**
 * Lower case, accents and marks off (Turkish ı too), apostrophes and
 * in-word hyphens dropped — "He's" → "hes", "J-1" → "j1", "в'язниця" →
 * "вязниця" — so one list matches every spelling.
 */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/(?<=[\p{L}\p{N}])[-‐‑](?=[\p{L}\p{N}])/gu, '');
}

const wordsOf = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

type Category = 'SECRET' | 'HEALTH' | 'RELIGION' | 'IMMIGRATION' | 'ORIENTATION' | 'CRIMINAL' | 'UNION';

/**
 * One entry per word or phrase; `stem*` matches any ending (inflected
 * languages: "вагітн*" is вагітна, вагітність…). A word that means
 * something harmless in another of the six languages is written as a
 * phrase instead (Spanish "hasta" is "until", so Turkish "sick" is
 * hastayım/hastalık; "Cristian" is a name, so "christian" needs "a").
 */
const WORDS: Record<Category, string> = {
  SECRET: [
    // en
    'password*|passcode*|pin|pin code|pin number|ssn|social security|routing number|account number|card number|cvv|login code',
    // es
    'contrasena*|clave|seguro social|numero de cuenta|numero de tarjeta',
    // tr
    'sifre*|parola*|hesap numara*|kart numara*|kimlik numara*|tc kimlik',
    // ht
    'modpas|nimewo kont|nimewo kat|sekirite sosyal',
    // pt
    'senha*|numero da conta|numero do cartao|cpf',
    // uk
    'пароль*|номер рахунку|номер картки|пінкод*',
  ].join('|'),
  HEALTH: [
    'pregnan*|diabet*|cancer|chemo*|hiv|std|asthma|depress*|anxiety|anxious|adhd|autis*|bipolar|ptsd|ocd|disability|disabled|wheelchair|medication*|meds|medicine|prescription*|diagnos*|therapy|therapist|surgery|doctor|doctors|hospital|illness|sick|epilep*|seizure*|migraine*|injur*|miscarriage|abortion|ivf|fertility|mental health|blood pressure|heart condition|heart attack|allerg*|insulin|covid|vaccin*|dialysis|rehab|sober|sobriety|alcoholic|addict*|overdose|deaf|blind|maternity|medical|back pain|chronic pain',
    'embarazada|embarazo|diabetic*|quimio*|vih|sida|asma|depresion|deprimid*|ansiedad|discapacidad|discapacitad*|silla de ruedas|medicamento*|medicina|receta medica|diagnostic*|terapia|cirugia|medico|enfermo|enferma|enfermedad|epilepsia|convulsion*|migrana|lesion|aborto|salud mental|presion arterial|alergi*|insulina|vacuna*|dialisis|adiccion|sordo|sorda|ciego|ciega|licencia de maternidad|dolor de espalda',
    'hamile*|gebe*|diyabet*|seker hastasi|kanser*|kemoterapi*|astim*|depresyon*|anksiyete*|engelli*|tekerlekli sandalye|ilac*|recete*|teshis*|terapi*|ameliyat*|doktor*|hastane*|hastayim|hastalik*|epilepsi*|migren*|sakatlik*|kurtaj*|ruh sagligi|tansiyon*|alerji*|insulin*|diyaliz*|bagimli*|sagir*|dogum izni',
    'ansent|gwoses|dyabet|kanse|chimyoterapi|opresyon|andikap*|chez woulant|medikaman|preskripsyon|dyagnostik|dokte|lopital|malad*|migren|blese|avotman|sante mantal|tansyon|aleji|ensilin|vaksen*|aveg|konje matenite',
    'gravida|gravidez|aids|quimioterapia|ansiedade|deficiencia|deficiente|cadeira de rodas|remedio*|receita medica|cirurgia|doente|doenca|enxaqueca|lesao|saude mental|pressao alta|vacina*|dialise|surdo|surda|cego|cega|licenca maternidade',
    'вагітн*|діабет*|рак|онколог*|хіміотерап*|віл|снід|астм*|депрес*|тривожн*|інвалід*|ліки|лікар*|лікуван*|діагноз*|терапі*|лікарн*|хвор*|епілепс*|мігрен*|травм*|аборт*|психічн* здоров*|алергі*|інсулін*|вакцин*|щеплен*|діаліз*|глух*|сліп*|декрет*',
  ].join('|'),
  RELIGION: [
    'religion|religious|church|mosque|synagogue|temple|pray|praying|prayer*|muslim|a christian|im christian|christianity|catholic|jewish|hindu|buddhist|sikh|mormon|atheist|jehovah*|ramadan|sabbath|bible|quran|koran|worship*|go to mass|sunday mass|kosher|halal|pastor|rabbi|imam',
    'religios*|iglesia|mezquita|sinagoga|templo|rezar|rezo|oracion|musulman*|cristiano|cristiana|cristianos|catolic*|judio*|judia|budista|mormon|ateo|atea|jehova|biblia|coran|misa|rabino',
    'din|dini|dinim|dindar*|kilise*|cami|camii|camiye|sinagog*|tapinak*|namaz*|dua et*|musluman*|hristiyan*|katolik*|yahudi*|budist*|ateist*|ramazan*|oruc*|incil*|kuran*|ibadet*|helal|koser|papaz*|haham*',
    'relijyon|legliz|moske|priye|lapriye|mizilman|kretyen|jwif|endou|boudis|lames|vodou|ougan',
    'religiao|igreja|mesquita|rezar|reza|oracao|muculman*|cristao|crista|judeu|judaic*|ateu|ateia|jeova|alcorao|culto|missa|candomble|umbanda|evangelic*|crente',
    'релігі*|церкв*|мечет*|синагог*|храм*|молит*|мусульман*|християн*|католи*|юде*|індуї*|буддист*|атеїст*|рамадан*|біблі*|коран*|богослужін*|халял*|кошерн*|священик*|рабин*|імам*|православн*',
  ].join('|'),
  IMMIGRATION: [
    'visa|visas|green card|immigra*|undocumented|illegal immigrant|illegal alien|im illegal|asylum|refugee*|deport*|citizenship|citizen|naturaliz*|work permit|ead|h1b|h2b|h2a|j1|tps|daca|uscis|passport|permanent resident|residency|overstay*|i94|sevis|u4u',
    'tarjeta verde|inmigra*|indocumentad*|soy ilegal|asilo|refugiad*|ciudadania|ciudadan*|permiso de trabajo|sin papeles|pasaporte|residencia|residente permanente|migratori*',
    'vize*|yesil kart|gocmen*|goc|kacak|siginma*|multeci*|sinir disi|vatandas*|calisma izni|oturma izni|pasaport*|ikamet*',
    'viza|kat vet|imigrasyon|imigran|san papye|ilegal|azil|refijye|depote|depotasyon|sitwayen*|pemi travay|paspo|rezidans',
    'meu visto|visto de trabalho|cartao verde|imigra*|indocumentad*|refugiad*|cidadania|cidadao|autorizacao de trabalho|passaporte|residencia permanente|sem documentos',
    'віза|візу|візи|візою|візі|візов*|грінкард*|імміграц*|іммігрант*|мігрант*|нелегал*|біжен*|депорт*|громадянств*|дозвіл на роботу|паспорт*|посвідк*',
  ].join('|'),
  ORIENTATION: [
    'gay|lesbian*|bisexual|homosexual|heterosexual|queer|transgender|nonbinary|lgbt*|sexual orientation|pansexual|asexual',
    'lesbiana|transgenero|no binari*|orientacion sexual',
    'gey|escinsel*|lezbiyen*|biseksuel*|heteroseksuel*|transseksuel*|cinsel yonelim',
    'masisi|madivin|lesbyen|biseksyel|omoseksyel',
    'lesbica|bissexual|homossexual|heterossexual|nao binari*|orientacao sexual',
    'гей|лесбі*|бісексуал*|гомосексуал*|гетеросексуал*|трансгендер*|квір|лгбт*|сексуальн* орієнтац*',
  ].join('|'),
  CRIMINAL: [
    'criminal|felony|felon|misdemeanor|convicted|conviction*|arrest*|jail|prison|probation|parole|dui|dwi|court date|court case|inmate|incarcerat*|ankle monitor|sex offender|background check',
    'antecedentes|delito*|crimen|condenad*|condena|carcel|prision|estuve preso|estuve presa|libertad condicional|fianza|cita en la corte',
    'sabika*|suc|suclu*|mahkum*|hapis*|cezaevi*|hapishane*|tutukl*|gozalti*|sartli tahliye|mahkeme*',
    'dosye kriminel|kriminel|krim|kondane|prizon|lajol|pwobasyon|libete kondisyonel|tribinal',
    'ficha criminal|crime|condenacao|fui preso|fui presa|estive preso|estive presa|prisao|na cadeia|penitenciaria|liberdade condicional|fianca|tribunal',
    'судим*|злочин*|кримінал*|засуджен*|арешт*|вязниц*|тюрм*|увязнен*|пробац*|суд|суду|суді',
  ].join('|'),
  UNION: [
    'union member|labor union|labour union|trade union|the union|in a union|my union|union dues|union rep|unionized|unionize|teamsters|seiu|unite here|aflcio|on strike|shop steward|collective bargaining',
    'sindicato|sindical*|huelga',
    'sendika*|grev*',
    'sendika|sendikal*|grev',
    'greve',
    'профспілк*|профсоюз*|страйк*',
  ].join('|'),
};

/** Words that start a sentence about someone else: their pronoun, or "my wife…", "mi jefe…", "oğlum…". */
// Not "they" / "ellos" / "вони": "They call me Rafa at work" is about the person.
const THIRD_PERSON = 'he|she|his|her|hers|him|hes|shes|ella|ele|ela|dele|dela|onun|він|вона|його|її|їхній';
const POSSESSIVES = 'my|mi|mis|meu|minha|meus|minhas|мій|моя|мої|моє';
const RELATIONS = [
  'wife|husband|son|daughter|kid|kids|child|children|mom|mother|dad|father|brother|sister|partner|boyfriend|girlfriend|fiance|fiancee|coworker|coworkers|colleague|manager|boss|supervisor|friend|neighbor|neighbour|roommate|cousin|aunt|uncle|grandma|grandmother|grandpa|grandfather|baby|spouse|ex|family',
  'esposa|esposo|marido|mujer|hijo|hija|hijos|hijas|nino|nina|ninos|bebe|mama|madre|papa|padre|padres|hermano|hermana|novio|novia|pareja|companero|companera|companeros|jefe|jefa|supervisora|gerente|amigo|amiga|vecino|vecina|primo|prima|tio|tia|abuela|abuelo|familia',
  'filho|filha|filhos|filhas|mae|pai|pais|irmao|irma|namorado|namorada|parceiro|parceira|companheiro|companheira|colega|colegas|chefe|vizinho|vizinha|avo',
  'чоловік|син|батько|тато|брат|хлопець|наречений|колега|начальник|керівник|менеджер|друг|сусід|партнер|дружина|жінка|донька|дочка|мама|мати|сестра|дівчина|наречена|начальниця|керівниця|подруга|сусідка|діти|батьки|дитина|родина|сімя',
].join('|');
/** Turkish says "my" with an ending (eşim, oğlum); Haitian after the noun (madanm mwen). */
const TR_MY_RELATION = 'esim|kocam|karim|oglum|kizim|cocugum|cocuklarim|annem|babam|kardesim|abim|ablam|sevgilim|nisanlim|arkadasim|is arkadasim|mudurum|patronum|sefim|amirim|komsum|kuzenim|teyzem|halam|amcam|dayim|ninem|dedem|ailem';
const HT_RELATION = 'madanm|mari|pitit|manman|papa|fre|zanmi|bos|koleg|vwazen|kouzen|kouzin|tonton|matant|fiyanse|menaj|fanmi';
/** Lead-ins a person types before the fact ("remember that…"). */
const LEAD_INS = 'remember|that|note|please|recuerda|recuerde|que|lembre|lembra|hatirla|sonje|ke|souple|запамятай|що';

interface Pattern {
  parts: Array<{ w: string; stem: boolean }>;
}

const toPatterns = (list: string): Pattern[] =>
  list.split('|').map((entry) => ({
    parts: entry
      .trim()
      .split(/\s+/)
      .map((p) => (p.endsWith('*') ? { w: fold(p.slice(0, -1)), stem: true } : { w: fold(p), stem: false })),
  }));

let compiled: { categories: Array<[Category, Pattern[]]>; third: Set<string>; poss: Set<string>; rel: Set<string>; tr: Pattern[]; ht: Set<string>; lead: Set<string> } | null = null;
/** Built on first use — nothing runs when the module loads (web-first-load rules). */
function lists() {
  compiled ??= {
    categories: (Object.keys(WORDS) as Category[]).map((c) => [c, toPatterns(WORDS[c])]),
    third: new Set(THIRD_PERSON.split('|').map(fold)),
    poss: new Set(POSSESSIVES.split('|').map(fold)),
    rel: new Set(RELATIONS.split('|').map(fold)),
    tr: toPatterns(TR_MY_RELATION),
    ht: new Set(HT_RELATION.split('|').map(fold)),
    lead: new Set(LEAD_INS.split('|').map(fold)),
  };
  return compiled;
}

const partMatches = (p: { w: string; stem: boolean }, word: string | undefined) => word !== undefined && (p.stem ? word.startsWith(p.w) : word === p.w);
const matchesAt = (pat: Pattern, words: string[], i: number) => pat.parts.every((p, k) => partMatches(p, words[i + k]));
const anyMatch = (pats: Pattern[], words: string[]) => words.some((_, i) => pats.some((p) => matchesAt(p, words, i)));

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;

/** The sensitive category a text falls in, if any (the order a person would want it caught). */
export function hugoMemorySensitive(text: string): Category | null {
  if (findSensitiveNumbers(text).length || EMAIL.test(text) || PHONE.test(text)) return 'SECRET';
  const words = wordsOf(text);
  for (const [category, pats] of lists().categories) if (anyMatch(pats, words)) return category;
  return null;
}

/** True when the text is about someone else: it starts with their pronoun, or with "my <relation>". */
export function hugoMemoryAboutSomeoneElse(text: string): boolean {
  const l = lists();
  const all = wordsOf(text);
  let i = 0;
  while (i < all.length - 1 && l.lead.has(all[i]!)) i += 1;
  const w = all.slice(i);
  if (!w.length) return false;
  if (l.third.has(w[0]!)) return true;
  if (w.length > 1 && l.poss.has(w[0]!) && l.rel.has(w[1]!)) return true;
  if (l.tr.some((p) => matchesAt(p, w, 0))) return true;
  return w.length > 1 && l.ht.has(w[0]!) && w[1] === 'mwen';
}

export type HugoMemoryCheck = { ok: true; text: string } | { ok: false; reason: Exclude<HugoMemoryRefusal, 'FULL' | 'OFF'> };

/**
 * The guard every fact passes before it is kept (lib/hugoMemory on the
 * server; the "Add something" field as the person types). Returns the text
 * as it will be kept — one line, spaces tidied — or why it can't be.
 */
export function checkHugoMemoryText(raw: string): HugoMemoryCheck {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'EMPTY' };
  if (text.length > HUGO_MEMORY_TEXT_MAX) return { ok: false, reason: 'TOO_LONG' };
  const sensitive = hugoMemorySensitive(text);
  if (sensitive) return { ok: false, reason: sensitive };
  if (hugoMemoryAboutSomeoneElse(text)) return { ok: false, reason: 'OTHER_PERSON' };
  return { ok: true, text };
}

/** The same fact twice is one fact: compared without case, accents or punctuation. */
export function hugoMemorySameText(a: string, b: string): boolean {
  return wordsOf(a).join(' ') === wordsOf(b).join(' ');
}
