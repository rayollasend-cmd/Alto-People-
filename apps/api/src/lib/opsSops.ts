import type { Prisma, PrismaClient, OpsPeriod, OpsResponseType } from '@prisma/client';
import { RETIRED_V1_NAMES, WALMART_METRIC_LABEL, WALMART_TEMPLATES } from './opsSopsWalmart.js';

/**
 * The seeded SOP library + position mapping for the Store Operations
 * module. The department libraries are the owner's own write-ups, made
 * executable: sections, ordered tasks, and typed responses (temperatures
 * carry min/max bounds so out-of-range readings flag instantly;
 * photo-required tasks can't be closed undocumented).
 *
 * Seeding is lazy and idempotent: `ensureOpsSeed` inserts the library
 * only when the OpsSopTemplate table is empty, so ops admins can edit or
 * retire anything afterwards without the seed fighting them. The one
 * exception is a one-time upgrade: a library seeded before the Walmart
 * department manual gets it (see ensureWalmartLibrary).
 */

interface SeedTask {
  title: string;
  section: string;
  responseType?: OpsResponseType;
  required?: boolean;
  photoRequired?: boolean;
  instructions?: string;
  tempLabel?: string;
  tempMin?: number;
  tempMax?: number;
  metricKey?: string;
  unit?: string;
  /** "HH:MM" — when the task's block is due. */
  dueTime?: string;
}

interface SeedTemplate {
  name: string;
  department: string;
  period: OpsPeriod;
  description?: string;
  tasks: SeedTask[];
}

export const OPS_DEPARTMENTS = [
  'Frozen & Dairy',
  'Meat & Produce',
  'Deli & Bakery',
  'Food & Consumables',
  'General Merchandise',
] as const;

/* Food-safety temperature bounds (°F). */
// Walmart's limits: refrigerated at or below 40°F (see lib/opsSopsWalmart).
const COOLER = { tempMin: 32, tempMax: 40 };
const COLD_CASE = { tempMin: 32, tempMax: 40 };
const HOT_HOLD = { tempMin: 135, tempMax: 165 };

const t = (
  section: string,
  title: string,
  extra: Partial<SeedTask> = {},
): SeedTask => ({ title, section, ...extra });

const DELI_BAKERY: SeedTemplate[] = [
  {
    name: 'Deli & Bakery — Morning',
    department: 'Deli & Bakery',
    period: 'MORNING',
    description: 'Temps, case setup, production, date labels, sanitation.',
    tasks: [
      t('Food safety', 'Check deli cooler temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Deli cooler °F',
        ...COOLER,
      }),
      t('Food safety', 'Confirm cold cases at or below required temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cold case °F',
        ...COLD_CASE,
      }),
      t('Food safety', 'Confirm hot-hold equipment at required temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Hot case °F',
        ...HOT_HOLD,
      }),
      t('Production', 'Inspect bakery items for quality and freshness'),
      t('Production', 'Stock deli cases with meats, cheeses, and prepared foods'),
      t('Production', 'Fill the hot case'),
      t('Production', 'Date-label all items', { responseType: 'YES_NO' }),
      t('Production', 'Pull expired deli or bakery products', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items discarded.',
      }),
      t('Production', 'Set the bakery display'),
      t('Production', 'Begin bakery production from the build-to list'),
      t('Production', 'Slice meats and cheeses to required levels'),
      t('Production', 'Prepare subs, trays, and platters', { required: false }),
      t('Sanitation', 'Sanitize slicers and prep surfaces', { responseType: 'YES_NO' }),
      t('Sanitation', 'Mid-shift temperature re-check', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cold case °F',
        ...COLD_CASE,
      }),
      t('Sanitation', 'Complete production logs', { responseType: 'YES_NO' }),
      t('Handoff', 'Prepare the area for the next shift', { responseType: 'TEXT' }),
    ],
  },
  {
    name: 'Deli & Bakery — Closing',
    department: 'Deli & Bakery',
    period: 'CLOSING',
    description: 'End-of-day pulls, markdowns, deep cleaning, closing logs.',
    tasks: [
      t('Close-down', 'Pull end-of-day items'),
      t('Close-down', 'Mark down products', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items marked down.',
      }),
      t('Close-down', 'Discard expired items', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items discarded.',
      }),
      t('Close-down', 'Break down and clean the hot case'),
      t('Close-down', 'Wrap and date remaining products'),
      t('Sanitation', 'Deep-clean cases, slicers, scales, and prep surfaces', {
        responseType: 'YES_NO',
      }),
      t('Sanitation', 'Clean floors and drains'),
      t('Sanitation', 'Restock supplies'),
      t('Sanitation', 'Closing temperature log', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cold case °F',
        ...COLD_CASE,
      }),
      t('Sanitation', 'Complete closing sanitation log', { responseType: 'YES_NO' }),
      t('Handoff', 'Prepare handoff notes for the morning team', { responseType: 'TEXT' }),
    ],
  },
];

const GENERAL_MERCH: SeedTemplate[] = [
  {
    name: 'General Merchandise — Morning',
    department: 'General Merchandise',
    period: 'MORNING',
    description: 'Walkthrough, freight, presentation, promo & modular compliance.',
    tasks: [
      t('Opening', 'Conduct an opening walkthrough'),
      t('Opening', 'Check for safety hazards', { responseType: 'YES_NO' }),
      t('Freight', 'Process overnight freight'),
      t('Freight', 'Stock shelves, pegs, and endcaps'),
      t('Freight', 'Bin overstock'),
      t('Freight', 'Remove cardboard'),
      t('Presentation', 'Verify advertised items are in stock', { responseType: 'YES_NO_PARTIAL' }),
      t('Presentation', 'Check promotional displays'),
      t('Presentation', 'Confirm signage is correct', { responseType: 'YES_NO' }),
      t('Presentation', 'Verify modular compliance', { responseType: 'YES_NO_PARTIAL' }),
      t('Presentation', 'Recover and zone aisles'),
      t('Presentation', 'Process apparel go-backs'),
      t('Presentation', 'Check fitting rooms'),
      t('Pricing', 'Execute price changes or markdowns', {
        responseType: 'NUMBER',
        required: false,
        instructions: 'Enter the number of price changes executed.',
      }),
      t('Close-out', 'Complete out-of-stock reports', { responseType: 'YES_NO' }),
      t('Handoff', 'Prepare handoff notes', { responseType: 'TEXT' }),
    ],
  },
  {
    name: 'General Merchandise — Closing',
    department: 'General Merchandise',
    period: 'CLOSING',
    description: 'Security, high-shrink areas, closing documentation.',
    tasks: [
      t('Security', 'Secure high-shrink areas', {
        responseType: 'PHOTO',
        photoRequired: true,
        instructions: 'Photo proof that the high-shrink area is secured.',
      }),
      t('Security', 'Confirm electronics cases are locked', { responseType: 'YES_NO' }),
      t('Security', 'Confirm TVs and other high-value products are secured', {
        responseType: 'YES_NO',
      }),
      t('Close-down', 'Recover and zone aisles'),
      t('Close-down', 'Clear cardboard and equipment'),
      t('Close-down', 'Complete closing documentation', { responseType: 'YES_NO' }),
      t('Handoff', 'Prepare handoff notes', { responseType: 'TEXT' }),
    ],
  },
];

/** Frozen & Dairy, Meat & Produce and Food & Consumables run the Walmart
 *  department manual (lib/opsSopsWalmart); Deli & Bakery and General
 *  Merchandise keep the first library's write-up. */
export const OPS_SEED_TEMPLATES: SeedTemplate[] = [
  ...WALMART_TEMPLATES.filter((tpl) => tpl.department !== 'Food & Consumables'),
  ...DELI_BAKERY,
  ...WALMART_TEMPLATES.filter((tpl) => tpl.department === 'Food & Consumables'),
  ...GENERAL_MERCH,
];

/* ===== Metric identity + closed-loop enrichment ========================== */

/**
 * Named metrics for the seed library's NUMBER tasks — "84" only becomes
 * data once it's cases_stocked in cases. Keys are the aggregation
 * identity across stores, departments and weeks.
 */
export const METRIC_BY_TITLE: Record<string, { metricKey: string; unit: string }> = {
  'Identify out-of-stocks, mispicks, and damaged products': { metricKey: 'oos_found', unit: 'items' },
  'Record out-of-stocks': { metricKey: 'oos_found', unit: 'items' },
  'Stock cases on the sales floor': { metricKey: 'cases_stocked', unit: 'cases' },
  'Stock shelves': { metricKey: 'cases_stocked', unit: 'cases' },
  'Stock Frozen': { metricKey: 'cases_stocked', unit: 'cases' },
  'Stock Dairy': { metricKey: 'cases_stocked', unit: 'cases' },
  'Receive the delivery': { metricKey: 'pallets_received', unit: 'pallets' },
  'Complete damage and expiration logs': { metricKey: 'items_discarded', unit: 'items' },
  'Dispose of spoiled products correctly': { metricKey: 'items_discarded', unit: 'items' },
  'Pull expired deli or bakery products': { metricKey: 'items_discarded', unit: 'items' },
  'Discard expired items': { metricKey: 'items_discarded', unit: 'items' },
  'Pull expired grocery items': { metricKey: 'items_discarded', unit: 'items' },
  'Mark down products': { metricKey: 'items_marked_down', unit: 'items' },
  'Execute price changes or markdowns': { metricKey: 'price_changes', unit: 'changes' },
};

/**
 * Closed-loop rules by response type: every temperature check re-verifies
 * on an out-of-range reading; every compliance question demands an
 * explanation on No (or Partial where partial exists).
 */
function followUpFor(task: SeedTask): {
  followUpOn: 'NO' | 'NO_OR_PARTIAL' | 'OUT_OF_RANGE' | null;
} {
  const rt = task.responseType ?? 'CHECK';
  if (rt === 'TEMPERATURE') return { followUpOn: 'OUT_OF_RANGE' };
  if (rt === 'YES_NO') return { followUpOn: 'NO' };
  if (rt === 'YES_NO_PARTIAL') return { followUpOn: 'NO_OR_PARTIAL' };
  return { followUpOn: null };
}

function enrichmentFor(task: SeedTask): {
  metricKey: string | null;
  unit: string | null;
  followUpOn: 'NO' | 'NO_OR_PARTIAL' | 'OUT_OF_RANGE' | null;
} {
  const metric = task.metricKey
    ? { metricKey: task.metricKey, unit: task.unit ?? null }
    : (METRIC_BY_TITLE[task.title] ?? null);
  return {
    metricKey: metric?.metricKey ?? null,
    unit: metric?.unit ?? null,
    ...followUpFor(task),
  };
}

type Db = PrismaClient | Prisma.TransactionClient;

function createTemplate(db: Db, tpl: SeedTemplate) {
  return db.opsSopTemplate.create({
    data: {
      name: tpl.name,
      department: tpl.department,
      period: tpl.period,
      description: tpl.description ?? null,
      tasks: {
        create: tpl.tasks.map((task, i) => ({
          section: task.section,
          order: i,
          title: task.title,
          instructions: task.instructions ?? null,
          responseType: task.responseType ?? 'CHECK',
          required: task.required ?? true,
          photoRequired: task.photoRequired ?? false,
          tempLabel: task.tempLabel ?? null,
          tempMin: task.tempMin ?? null,
          tempMax: task.tempMax ?? null,
          dueTime: task.dueTime ?? null,
          ...enrichmentFor(task),
        })),
      },
    },
    select: { id: true },
  });
}

const WALMART_NAMES = WALMART_TEMPLATES.map((tpl) => tpl.name);

/**
 * Idempotent lazy seed: inserts the library when it's empty, and brings a
 * library seeded before the Walmart manual up to it. Serialized on an
 * advisory lock — the library page and a shift opening at the same moment
 * must not seed twice.
 */
export async function ensureOpsSeed(prisma: PrismaClient): Promise<void> {
  const [total, walmart] = await Promise.all([
    prisma.opsSopTemplate.count(),
    prisma.opsSopTemplate.count({ where: { name: { in: WALMART_NAMES } } }),
  ]);
  if (total === 0 || walmart === 0) {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('alto.ops_sop_seed'))`;
        if ((await tx.opsSopTemplate.count()) === 0) {
          for (const tpl of OPS_SEED_TEMPLATES) await createTemplate(tx, tpl);
          return;
        }
        await ensureWalmartLibrary(tx);
      },
      { timeout: 60_000 },
    );
  }
  await ensureOpsEnrichment(prisma);
}

/**
 * One-time upgrade to the Walmart department manual: its SOPs join the
 * library, the first library's SOPs for those departments retire (shifts
 * already run keep their snapshots), and every store shift that ran one
 * now runs its successor — same department, same shift. Skipped once any
 * Walmart SOP exists, even a retired one: an admin who retired it meant it.
 */
async function ensureWalmartLibrary(tx: Prisma.TransactionClient): Promise<void> {
  if ((await tx.opsSopTemplate.count({ where: { name: { in: WALMART_NAMES } } })) > 0) return;
  const successor = new Map<string, string>();
  for (const tpl of WALMART_TEMPLATES) {
    const row = await createTemplate(tx, tpl);
    successor.set(`${tpl.department}|${tpl.period}`, row.id);
  }
  const old = await tx.opsSopTemplate.findMany({
    where: { name: { in: Object.keys(RETIRED_V1_NAMES) }, retiredAt: null },
    select: { id: true, name: true },
  });
  for (const o of old) {
    const to = RETIRED_V1_NAMES[o.name]!;
    const next = successor.get(`${to.department}|${to.period}`);
    if (next) {
      await tx.storeShiftSop.updateMany({ where: { templateId: o.id }, data: { templateId: next } });
    }
  }
  if (old.length > 0) {
    await tx.opsSopTemplate.updateMany({
      where: { id: { in: old.map((o) => o.id) } },
      data: { retiredAt: new Date(), active: false },
    });
  }
}

/**
 * One-time upgrade for libraries seeded BEFORE metrics/closed-loop
 * existed: fill metricKey/unit/followUpOn on seed-shaped tasks that
 * still have them null. Never overwrites an admin's explicit values,
 * and skips entirely once any enrichment is present.
 */
async function ensureOpsEnrichment(prisma: PrismaClient): Promise<void> {
  const already = await prisma.opsSopTemplateTask.count({
    where: { OR: [{ metricKey: { not: null } }, { followUpOn: { not: null } }] },
  });
  if (already > 0) return;
  for (const tpl of OPS_SEED_TEMPLATES) {
    for (const task of tpl.tasks) {
      const e = enrichmentFor(task);
      if (!e.metricKey && !e.followUpOn) continue;
      await prisma.opsSopTemplateTask.updateMany({
        where: { title: task.title, template: { is: { name: tpl.name } } },
        data: {
          ...(e.metricKey ? { metricKey: e.metricKey, unit: e.unit } : {}),
          ...(e.followUpOn ? { followUpOn: e.followUpOn } : {}),
        },
      });
    }
  }
}

/** Human labels for the seeded metric keys (client fallback humanizes). */
export const METRIC_LABEL: Record<string, string> = {
  cases_stocked: 'Cases stocked',
  items_discarded: 'Items discarded',
  items_marked_down: 'Items marked down',
  oos_found: 'Out-of-stocks found',
  pallets_received: 'Pallets received',
  price_changes: 'Price changes',
  ...WALMART_METRIC_LABEL,
};

/* ===== Position mapping ================================================== */

/**
 * Alto's scheduling positions already encode department + period ("F&D
 * Overnight Shift", "GM Morning Shift") — the ops shift derives both so
 * the supervisor never types what the schedule already knows.
 */
export function departmentForPosition(position: string): string | null {
  const p = position.toLowerCase();
  if (p.includes('f&d') || p.includes('frozen') || p.includes('dairy')) return 'Frozen & Dairy';
  if (p.includes('meat') || p.includes('produce')) return 'Meat & Produce';
  if (p.includes('deli') || p.includes('bakery')) return 'Deli & Bakery';
  if (p.includes('grocery') || p.includes('consumable') || p.includes('food')) {
    return 'Food & Consumables';
  }
  if (p.includes('gm') || p.includes('general') || p.includes('merch')) {
    return 'General Merchandise';
  }
  return null;
}

export function periodForPosition(position: string, hourLocal: number): OpsPeriod {
  const p = position.toLowerCase();
  if (p.includes('overnight') || p.includes('night')) return 'OVERNIGHT';
  if (p.includes('closing') || p.includes('close')) return 'CLOSING';
  if (p.includes('morning') || p.includes('opening') || p.includes('open')) return 'MORNING';
  if (p.includes('afternoon') || p.includes('evening') || p.includes('recovery')) return 'EVENING';
  // Fall back to the clock: before noon = morning, before 8pm = evening,
  // after = overnight.
  if (hourLocal < 12) return 'MORNING';
  if (hourLocal < 20) return 'EVENING';
  return 'OVERNIGHT';
}
