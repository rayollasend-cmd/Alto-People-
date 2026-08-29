import type { PrismaClient, OpsPeriod, OpsResponseType } from '@prisma/client';

/**
 * The seeded SOP library + position mapping for the Store Operations
 * module. The five department libraries below are the owner's own
 * write-up, made executable: sections, ordered tasks, and typed
 * responses (temperatures carry min/max bounds so out-of-range readings
 * flag instantly; photo-required tasks can't be closed undocumented).
 *
 * Seeding is lazy and idempotent: `ensureOpsSeed` inserts the library
 * only when the OpsSopTemplate table is empty, so ops admins can edit or
 * retire anything afterwards without the seed fighting them.
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
const FREEZER = { tempMin: -10, tempMax: 10 };
const COOLER = { tempMin: 33, tempMax: 41 };
const COLD_CASE = { tempMin: 32, tempMax: 41 };
const HOT_HOLD = { tempMin: 135, tempMax: 165 };

const t = (
  section: string,
  title: string,
  extra: Partial<SeedTask> = {},
): SeedTask => ({ title, section, ...extra });

const FROZEN_DAIRY: SeedTemplate[] = [
  {
    name: 'Frozen & Dairy — Morning',
    department: 'Frozen & Dairy',
    period: 'MORNING',
    description: 'Opening through midday: temps, aisles, backroom pulls, stocking, milk & eggs.',
    tasks: [
      t('Opening', 'Check in with the Department Manager or Team Lead'),
      t('Opening', 'Review overnight notes'),
      t('Opening', 'Verify cooler temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cooler °F',
        ...COOLER,
      }),
      t('Opening', 'Verify freezer temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Freezer °F',
        ...FREEZER,
      }),
      t('Opening', 'Walk Frozen & Dairy aisles'),
      t('Opening', 'Identify out-of-stocks, mispicks, and damaged products', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of out-of-stock items found.',
      }),
      t('Opening', 'Scan and cap backroom bins'),
      t('Opening', 'Pull products from the backroom'),
      t('Opening', 'Stock cases on the sales floor', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of cases stocked.',
      }),
      t('Opening', 'Bin overstock inventory'),
      t('Opening', 'Replenish milk and eggs'),
      t('Opening', 'Zone, face, straighten, and rotate products (FIFO)'),
      t('Mid-shift', 'Perform another temperature check', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cooler °F',
        ...COOLER,
      }),
      t('Mid-shift', 'Fill gaps on the sales floor'),
      t('Mid-shift', 'Finish binning overstock'),
      t('Mid-shift', 'Prepare the staging area for a truck'),
      t('Mid-shift', 'Communicate time-sensitive work before breaks'),
      t('Handoff', 'Prepare handoff notes for the next shift', {
        responseType: 'TEXT',
      }),
    ],
  },
  {
    name: 'Frozen & Dairy — Evening & Receiving',
    department: 'Frozen & Dairy',
    period: 'EVENING',
    description: 'Truck receiving, verification, downstacking, damage documentation.',
    tasks: [
      t('Receiving', 'Confirm truck arrival time', { responseType: 'TEXT' }),
      t('Receiving', 'Clear dock and staging space'),
      t('Receiving', 'Organize pallets'),
      t('Receiving', 'Receive the delivery', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of pallets received.',
      }),
      t('Receiving', 'Verify product count and condition', { responseType: 'YES_NO_PARTIAL' }),
      t('Receiving', 'Downstack pallets'),
      t('Receiving', 'Separate damaged or mispicked products'),
      t('Receiving', 'Photograph damaged merchandise', {
        responseType: 'PHOTO',
        photoRequired: true,
        required: false,
        instructions: 'Required whenever damage is found on the truck.',
      }),
      t('Floor', 'Evening temperature check', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Freezer °F',
        ...FREEZER,
      }),
      t('Floor', 'Fill priority gaps before close'),
      t('Handoff', 'Prepare handoff notes for the overnight team', { responseType: 'TEXT' }),
    ],
  },
  {
    name: 'Frozen & Dairy — Overnight',
    department: 'Frozen & Dairy',
    period: 'OVERNIGHT',
    description: 'Overnight stocking, cross-department delivery, damage & expiration logs.',
    tasks: [
      t('Stocking', 'Stock Frozen', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of cases stocked.',
      }),
      t('Stocking', 'Stock Dairy', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of cases stocked.',
      }),
      t('Stocking', 'Stock Department 97'),
      t('Stocking', 'Deliver products to other departments'),
      t('Stocking', 'Replenish milk and eggs'),
      t('Stocking', 'Overnight temperature check', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Freezer °F',
        ...FREEZER,
      }),
      t('Close-down', 'Remove trash, cardboard, and empty pallets'),
      t('Close-down', 'Complete damage and expiration logs', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items discarded or pulled for expiration.',
      }),
      t('Handoff', 'Prepare handoff notes for the morning team', { responseType: 'TEXT' }),
    ],
  },
];

const MEAT_PRODUCE: SeedTemplate[] = [
  {
    name: 'Meat & Produce — Morning',
    department: 'Meat & Produce',
    period: 'MORNING',
    description: 'Food safety, freshness, FIFO stocking, sanitation, customer service.',
    tasks: [
      t('Receiving', 'Safely unload incoming meat and produce deliveries'),
      t('Receiving', 'Inspect shipments for temperature, freshness, quality, and damage', {
        responseType: 'YES_NO_PARTIAL',
      }),
      t('Receiving', 'Record delivery temperature', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Delivery °F',
        ...COOLER,
      }),
      t('Receiving', 'Verify product labels and packaging', { responseType: 'YES_NO' }),
      t('Receiving', 'Photograph damaged product', {
        responseType: 'PHOTO',
        photoRequired: true,
        required: false,
        instructions: 'Required whenever damaged product is found.',
      }),
      t('Floor', 'Stock shelves, bins, and refrigerated cases'),
      t('Floor', 'Rotate product using FIFO (oldest to the front)'),
      t('Floor', 'Organize backroom storage by freshness and product type'),
      t('Floor', 'Set up seasonal produce displays', { required: false }),
      t('Floor', 'Help customers select or weigh produce', { required: false }),
      t('Food safety', 'Sanitize knives, tools, and cutting boards', { responseType: 'YES_NO' }),
      t('Food safety', 'Confirm gloves, aprons, and required PPE are worn', {
        responseType: 'YES_NO',
      }),
      t('Food safety', 'Follow cold-chain procedures', { responseType: 'YES_NO' }),
      t('Food safety', 'Dispose of spoiled products correctly', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items disposed.',
      }),
      t('Food safety', 'Complete daily sanitation and temperature logs', { responseType: 'YES_NO' }),
      t('Handoff', 'Prepare handoff notes', { responseType: 'TEXT' }),
    ],
  },
  {
    name: 'Meat & Produce — Team Lead',
    department: 'Meat & Produce',
    period: 'EVENING',
    description: 'Leadership responsibilities: huddle, assignments, compliance, breaks, handoff.',
    tasks: [
      t('Leadership', 'Conduct the team huddle'),
      t('Leadership', 'Assign duties'),
      t('Leadership', 'Supervise food-safety compliance', { responseType: 'YES_NO' }),
      t('Leadership', 'Monitor inventory and displays'),
      t('Leadership', 'Handle customer concerns', {
        responseType: 'TEXT',
        required: false,
        instructions: 'Describe any customer concerns handled this shift.',
      }),
      t('Leadership', 'Review associate logs'),
      t('Leadership', 'Manage breaks'),
      t('Food safety', 'Cold case temperature check', {
        responseType: 'TEMPERATURE',
        tempLabel: 'Cold case °F',
        ...COLD_CASE,
      }),
      t('Handoff', 'Prepare handoff notes', { responseType: 'TEXT' }),
    ],
  },
];

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

const FOOD_CONSUMABLES: SeedTemplate[] = [
  {
    name: 'Food & Consumables — Morning',
    department: 'Food & Consumables',
    period: 'MORNING',
    description: 'Grocery stocking, backroom picks, shelf presentation, inventory accuracy.',
    tasks: [
      t('Opening', 'Check in with the Grocery Team Lead'),
      t('Opening', 'Review overnight notes'),
      t('Opening', 'Walk assigned aisles'),
      t('Opening', 'Record out-of-stocks', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of out-of-stock items.',
      }),
      t('Backroom', 'Scan backroom bins'),
      t('Backroom', 'Generate picks'),
      t('Backroom', 'Pull cases to the sales floor'),
      t('Floor', 'Stock shelves', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of cases stocked.',
      }),
      t('Floor', 'Face products'),
      t('Floor', 'Bin overstock'),
      t('Floor', 'Verify shelf tags', { responseType: 'YES_NO' }),
      t('Floor', 'Check planogram / modular compliance', { responseType: 'YES_NO_PARTIAL' }),
      t('Floor', 'Rotate products using FIFO'),
      t('Floor', 'Pull expired grocery items', {
        responseType: 'NUMBER',
        instructions: 'Enter the number of items pulled.',
      }),
      t('Mid-shift', 'Coordinate coverage before lunch'),
      t('Mid-shift', 'Continue carryover stocking'),
      t('Mid-shift', 'Zone and face aisles'),
      t('Mid-shift', 'Organize U-boats, flats, and staging areas'),
      t('Close-out', 'Complete an out-of-stock report', { responseType: 'YES_NO' }),
      t('Close-out', 'Perform a final aisle walkthrough'),
      t('Handoff', 'Write handoff notes', { responseType: 'TEXT' }),
    ],
  },
  {
    name: 'Food & Consumables — Evening Recovery',
    department: 'Food & Consumables',
    period: 'EVENING',
    description: 'Recovery after customer traffic, promo execution, backroom prep.',
    tasks: [
      t('Recovery', 'Recover aisles after customer traffic'),
      t('Recovery', 'Complete unfinished stocking'),
      t('Recovery', 'Execute promotional displays'),
      t('Recovery', 'Restock high-velocity items'),
      t('Recovery', 'Clear cardboard and equipment'),
      t('Backroom', 'Prepare backroom bins for the morning team'),
      t('Handoff', 'Write handoff notes', { responseType: 'TEXT' }),
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

export const OPS_SEED_TEMPLATES: SeedTemplate[] = [
  ...FROZEN_DAIRY,
  ...MEAT_PRODUCE,
  ...DELI_BAKERY,
  ...FOOD_CONSUMABLES,
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
  const metric = METRIC_BY_TITLE[task.title] ?? null;
  return {
    metricKey: metric?.metricKey ?? null,
    unit: metric?.unit ?? null,
    ...followUpFor(task),
  };
}

/** Idempotent lazy seed: inserts the library only when it's empty. */
export async function ensureOpsSeed(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.opsSopTemplate.count();
  if (existing > 0) {
    await ensureOpsEnrichment(prisma);
    return;
  }
  for (const tpl of OPS_SEED_TEMPLATES) {
    await prisma.opsSopTemplate.create({
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
            ...enrichmentFor(task),
          })),
        },
      },
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
