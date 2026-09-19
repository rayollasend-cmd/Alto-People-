import type { OpsPeriod, OpsResponseType } from '@prisma/client';

/**
 * The Walmart department SOPs — the owner's "Walmart Department Operations
 * Manual" (Frozen & Dairy, Food & Consumables, Meat & Produce), rebuilt as
 * live, timed checklists a Team Lead runs through their portal.
 *
 * What changed from the manual, and why:
 *   - Every block carries a DUE time (its end — "by 9:00 AM") so the Team
 *     Lead and the store manager see what's late the moment it's late, not
 *     at the end of the shift.
 *   - Outcomes are MEASURED, not just ticked: picks worked, pallets
 *     received, cases stocked, overstock binned, claims, discards,
 *     donations, returns — the numbers the store manager reviews.
 *   - Compliance points are Yes / No / Partial questions; a No (or a
 *     Partial) opens a corrective follow-up task on the spot. Temperatures
 *     carry food-safety ranges — an out-of-range reading re-checks.
 *   - The final zone of every shift is a PHOTO — evidence, not a tick.
 *   - Times reconciled: Frozen & Dairy mornings start at 7:00 (the manual's
 *     blocks started at 6:00 on a 7–4 shift); the overnight 5–6 AM gap is
 *     folded into stocking; Frozen & Dairy evenings take the 1-hour lunch
 *     the shift header states.
 *   - Meat & Produce had no shift times: its associate and Team Lead
 *     checklists become a Morning (6 AM–3 PM: receiving, processing,
 *     stocking) and an Evening (2–11 PM: recovery, markdowns, donations,
 *     closing sanitation) SOP, the Team Lead's duties built in.
 *   - Clock-in/out lines are gone (the kiosk records them), as are
 *     "update the handoff log" lines — the SOP can't be submitted without
 *     its handover to the next shift.
 *   - Weekly leadership work (meetings, sales/shrink reviews, training)
 *     isn't a shift task and stays out of the shift SOP.
 *
 * Temperatures (°F): freezer cases run at 0°F and flag above 10°F; dairy
 * and produce coolers 33–41°F; fresh meat 28–40°F; on the truck, frozen
 * loads at or below 10°F and refrigerated loads 28–41°F.
 */

export interface WalmartTask {
  title: string;
  section: string;
  /** "HH:MM" store time the block is due by. */
  dueTime: string;
  responseType?: OpsResponseType;
  required?: boolean;
  photoRequired?: boolean;
  instructions?: string;
  tempLabel?: string;
  tempMin?: number;
  tempMax?: number;
  metricKey?: string;
  unit?: string;
}

export interface WalmartTemplate {
  name: string;
  department: string;
  period: OpsPeriod;
  description: string;
  tasks: WalmartTask[];
}

const FREEZER = { tempMin: -20, tempMax: 10 };
const COOLER = { tempMin: 33, tempMax: 41 };
const MEAT_CASE = { tempMin: 28, tempMax: 40 };
const FROZEN_LOAD = { tempMin: -20, tempMax: 10 };
const COLD_LOAD = { tempMin: 28, tempMax: 41 };

type Extra = Omit<Partial<WalmartTask>, 'title' | 'section' | 'dueTime'>;

/** A timed block: its tasks share the section and the due time. */
function block(section: string, dueTime: string, items: Array<[string, Extra?]>): WalmartTask[] {
  return items.map(([title, extra]) => ({ title, section, dueTime, ...(extra ?? {}) }));
}

const temp = (label: string, range: { tempMin: number; tempMax: number }): Extra => ({
  responseType: 'TEMPERATURE',
  tempLabel: label,
  ...range,
});
const count = (metricKey: string, unit: string, instructions: string): Extra => ({
  responseType: 'NUMBER',
  metricKey,
  unit,
  instructions,
});
const yesNo = (instructions?: string): Extra => ({ responseType: 'YES_NO', ...(instructions ? { instructions } : {}) });
const partial = (instructions?: string): Extra => ({
  responseType: 'YES_NO_PARTIAL',
  ...(instructions ? { instructions } : {}),
});
const photo = (instructions: string): Extra => ({ responseType: 'PHOTO', photoRequired: true, instructions });
const text = (instructions: string): Extra => ({ responseType: 'TEXT', instructions });

const LUNCH = (section: string, due: string) =>
  block(section, due, [
    [
      'Lunches approved by the Team Lead, with floor and temperature coverage kept',
      yesNo('Each associate takes the 1-hour unpaid lunch only with approval, and someone covers the floor and the cases.'),
    ],
  ]);

/* ===== Frozen & Dairy ==================================================== */

const FD_MORNING: WalmartTemplate = {
  name: 'Frozen & Dairy — Morning (7 AM–4 PM)',
  department: 'Frozen & Dairy',
  period: 'MORNING',
  description: 'Restock & prepare: scan and cap bins, priority picks, overstock, milk & eggs, zone, ready for the truck.',
  tasks: [
    ...block('Start of shift · 7:00–7:30', '07:30', [
      ['Check in with the Department Manager or Team Lead'],
      ['Review overnight notes and set task priorities'],
      ['Dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Freezer case temperature', temp('Freezer °F', FREEZER)],
    ]),
    ...block('Backroom · 7:30–9:30', '09:30', [
      ['All backroom bins scanned and capped', partial()],
      ['Priority picks from overnight completed', count('picks_worked', 'picks', 'How many picks were worked?')],
      ['Picks stocked in the correct modulars'],
      ['Overnight overstock binned in labeled locations', count('overstock_binned', 'cases', 'Cases binned.')],
      ['Backroom cleaned and organized — pallets, packaging, labels'],
      ['Delivery truck ETA', text('When is the truck due? ("2:30 PM", "not today")')],
    ]),
    ...block('Sales floor replenishment · 9:30–11:00', '11:00', [
      ['Milk, eggs, butter, cheese and yogurt full', partial('Partial opens a follow-up for what is still out.')],
      ['Frozen cases stocked — ice cream, meals, vegetables', count('cases_stocked', 'cases', 'Cases stocked.')],
      ['Product rotated first-in, first-out while stocking'],
      ['Expired and near-expiry product pulled', count('items_discarded', 'items', 'Items pulled.')],
      ['Damaged and expired merchandise claimed', count('claims_processed', 'claims', 'Claims processed.')],
    ]),
    ...LUNCH('Lunch · 11:00–12:00', '12:00'),
    ...block('Midday · 12:00–3:00', '15:00', [
      ['Midday dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Midday freezer case temperature', temp('Freezer °F', FREEZER)],
      ['Sales floor zoned and gaps filled'],
      ['All overstock from morning picks binned', yesNo()],
      ['Backroom and receiving area ready for the truck'],
      ['Overnight carryover tasks addressed', partial()],
    ]),
    ...block('End of shift · 3:00–4:00', '16:00', [
      ['Final zone — shelves faced, products aligned, cases clean', photo('A photo of the department after the final zone.')],
      ['Trash, empty pallets and cardboard removed'],
      ['Temperature logs complete for the shift', yesNo()],
      ['All equipment working — coolers, freezers, TC scanner, pallet jacks', yesNo('No opens a follow-up to report it to the supervisor.')],
    ]),
  ],
};

const FD_EVENING: WalmartTemplate = {
  name: 'Frozen & Dairy — Evening (2–11 PM)',
  department: 'Frozen & Dairy',
  period: 'EVENING',
  description: 'Organize & maintain: morning handoff, scan bins, stock, customer service, receive and downstack the truck.',
  tasks: [
    ...block('Start of shift · 2:00–2:30', '14:30', [
      ['Check in with the Department Supervisor or Team Lead'],
      ['Review the 7–4 handoff and set task priorities'],
      ['Dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Freezer case temperature', temp('Freezer °F', FREEZER)],
      ['TC scanner on and working', yesNo()],
      ['Tools gathered — gloves, box cutter, labels, backroom cart'],
      ['Lunch times set with the Team Lead'],
    ]),
    ...block('Backroom · 2:30–5:00', '17:00', [
      ['Bins scanned for product needed on the floor'],
      ['Sales floor stocked from backroom and picks', count('cases_stocked', 'cases', 'Cases stocked.')],
      ['Overstock binned with accurate location labels', count('overstock_binned', 'cases', 'Cases binned.')],
      ['Backroom clean — trash out, pallets consolidated'],
      ['Mid-shift dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Mid-shift freezer case temperature', temp('Freezer °F', FREEZER)],
    ]),
    ...block('Sales floor & customers · 5:00–7:00', '19:00', [
      ['High-volume items refilled — milk, eggs, yogurt, butter, ice cream', partial()],
      ['Shelves zoned — faced, straightened, rotated first-in, first-out'],
      ['Floors clean and dry, aisles clear', yesNo()],
      ['Expired and damaged product pulled', count('items_discarded', 'items', 'Items pulled.')],
      ['Price tags checked against the product', yesNo()],
    ]),
    ...LUNCH('Lunch · 7:00–8:00', '20:00'),
    ...block('Truck receiving · 8:00–10:00', '22:00', [
      ['Truck ETA confirmed; dock and staging clear'],
      ['Truck received', count('pallets_received', 'pallets', 'Pallets received.')],
      ['Product count and condition verified', partial('Partial opens a follow-up to claim what came in short or damaged.')],
      ['Pallets downstacked by section and rotation order'],
      ['Frozen and dairy pallets separated and labeled'],
      ['Replenishing the floor from the new freight'],
    ]),
    ...block('End of shift · 10:00–11:00', '23:00', [
      ['Final zone and recovery', photo('A photo of the department after the final zone.')],
      ['Trash, cardboard and shrink wrap removed'],
      ['Closing dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Closing freezer case temperature', temp('Freezer °F', FREEZER)],
      ['All equipment working', yesNo('No opens a follow-up to report it to the supervisor.')],
    ]),
  ],
};

const FD_OVERNIGHT: WalmartTemplate = {
  name: 'Frozen & Dairy — Overnight (10 PM–7 AM)',
  department: 'Frozen & Dairy',
  period: 'OVERNIGHT',
  description: 'Receive & rebuild: the truck, downstack, stock Frozen, Dairy and Dept 97, deliver cross-department, morning-ready.',
  tasks: [
    ...block('Start of shift · 10:00–10:30', '22:30', [
      ['Check in with the Overnight Supervisor or Team Lead'],
      ['Review the communication log and evening notes'],
      ['Dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Freezer case temperature', temp('Freezer °F', FREEZER)],
      ['Tools and equipment gathered — gloves, cutters, TC scanner, carts'],
      ['Work zones assigned for Frozen, Dairy and Department 97'],
    ]),
    ...block('Truck receiving · 10:30–12:00', '00:00', [
      ['Load inspected for damage and temperature', yesNo('No opens a follow-up to document and claim it.')],
      ['Frozen load temperature', temp('Frozen load °F', FROZEN_LOAD)],
      ['Refrigerated load temperature', temp('Dairy load °F', COLD_LOAD)],
      ['Truck received', count('pallets_received', 'pallets', 'Pallets received.')],
      ['Pallets downstacked and sorted — Frozen, Dairy, Dept 97, Deli/Bakery/Produce'],
      ['Interdepartmental pallets staged by their departments'],
      ['Aisles and walkways kept clear while downstacking', yesNo()],
    ]),
    ...block('Stocking · 12:00–2:00', '02:00', [
      ['Frozen, Dairy and Dept 97 stocked, cold chain kept', count('cases_stocked', 'cases', 'Cases stocked.')],
      ['Stock rotated first-in, first-out'],
      ['Overstock reorganized; backroom neat'],
    ]),
    ...LUNCH('Lunch · 2:00–3:00', '03:00'),
    ...block('Stocking · 3:00–6:00', '06:00', [
      ['Deli, Bakery and Produce product delivered to their departments', yesNo()],
      ['Expired items removed or re-dated', count('items_discarded', 'items', 'Items removed.')],
      ['Deep zone and facing on every shelf'],
    ]),
    ...block('Morning readiness · 6:00–7:00', '07:00', [
      ['Milk and eggs full for the morning', partial()],
      ['Sales floor zoned; condensation wiped'],
      ['Trash, cardboard and empty pallets removed'],
      ['Damaged and expired merchandise claims and logs finalized', count('claims_processed', 'claims', 'Claims processed.')],
      ['Closing dairy cooler temperature', temp('Dairy cooler °F', COOLER)],
      ['Closing freezer case temperature', temp('Freezer °F', FREEZER)],
      ['Final walkthrough — department clean, organized, compliant', photo('A photo of the department ready for the morning.')],
    ]),
  ],
};

/* ===== Food & Consumables ================================================ */

const FC_MORNING: WalmartTemplate = {
  name: 'Food & Consumables — Morning (6 AM–3 PM)',
  department: 'Food & Consumables',
  period: 'MORNING',
  description: 'Handoff, overstock, VIZPICK, topstock, returns, features, zone.',
  tasks: [
    ...block('Overnight handoff & assessment · 6:00–7:00', '07:00', [
      ['Handoff with the overnight supervisor or Team Lead'],
      ['Freight left from overnight', count('freight_left', 'pallets', 'Pallets or carts not finished overnight (0 if none).')],
      ['Aisles checked for unfinished or improperly worked freight', partial()],
      ['Merchandise in wrong locations corrected'],
      ['Backroom checked for overnight overstock'],
      ['Cardboard, plastic and trash removed overnight', yesNo('No opens a follow-up to clear it.')],
      ['Unfinished overnight work prioritized before routine tasks'],
    ]),
    ...block('Overstock verification & binning · 7:00–9:00', '09:00', [
      ['Overnight overstock worked before binning; shelf capacity checked'],
      ['Case labels match the merchandise', yesNo()],
      ['Verified overstock binned by department and category', count('overstock_binned', 'cases', 'Cases binned.')],
      ['Mislabeled or misbinned merchandise corrected'],
      ['Backroom pathways clear and safe', yesNo()],
    ]),
    ...block('VIZPICK · 9:00–11:00', '11:00', [
      ['Assigned Food & Consumables bins scanned', partial()],
      ['Picks worked to the sales floor', count('picks_worked', 'picks', 'Picks worked.')],
      ['Picks stocked in the verified shelf location'],
      ['True overstock returned to its bin'],
      ['Inaccurate bin locations corrected'],
    ]),
    ...block('Topstock · 11:00–12:00', '12:00', [
      ['Assigned topstock sections worked', partial()],
      ['Topstock brought down wherever the shelf has room'],
      ['Topstock sits above its own section; misplaced topstock corrected'],
      ['Empty boxes and packaging removed'],
      ['Topstock is not hiding stocking errors or open shelf space', yesNo()],
    ]),
    ...LUNCH('Lunch · 12:00–1:00', '13:00'),
    ...block('Returns, claims & features · 1:00–2:00', '14:00', [
      ['Returns sorted and put back in the correct locations', count('returns_worked', 'items', 'Items returned to the shelf.')],
      ['Damaged merchandise separated for claims', count('claims_processed', 'claims', 'Claims processed.')],
      ['High-traffic end caps and features replenished', partial()],
      ['Signage matches the merchandise', yesNo()],
    ]),
    ...block('Zone & evening handoff · 2:00–3:00', '15:00', [
      ['Assigned aisles zoned — pulled forward and faced', photo('A photo of a zoned aisle.')],
      ['Misplaced merchandise corrected; cardboard and trash removed'],
      ['High-traffic areas checked'],
      ['Carts and equipment left organized'],
    ]),
  ],
};

const FC_EVENING: WalmartTemplate = {
  name: 'Food & Consumables — Evening (2–11 PM)',
  department: 'Food & Consumables',
  period: 'EVENING',
  description: 'Replenishment, customer service, recovery, returns, overnight preparation.',
  tasks: [
    ...block('Morning handoff · 2:00–3:00', '15:00', [
      ['Handoff received from the morning team'],
      ['Incomplete VIZPICKs, topstock, returns and claims reviewed'],
      ['Outs on high-demand items', count('oos_found', 'items', 'Items out of stock.')],
      ['Tonight’s priorities', text('The top priorities for the evening.')],
    ]),
    ...block('Replenishment · 3:00–5:00', '17:00', [
      ['High-demand merchandise replenished', partial()],
      ['Available picks worked', count('picks_worked', 'picks', 'Picks worked.')],
      ['Shelves filled wherever backroom merchandise is available'],
      ['End caps and promotional features replenished'],
      ['Aisles customer-ready while stocking', yesNo()],
    ]),
    ...block('Customers, returns & recovery · 5:00–7:00', '19:00', [
      ['Customers helped to find merchandise'],
      ['Department returns worked', count('returns_worked', 'items', 'Items returned to the shelf.')],
      ['Heavily shopped areas recovered'],
      ['Aisles clear of carts and obstructions', yesNo()],
    ]),
    ...block('Lunch · 7:00–7:30', '19:30', [
      ['Lunches approved by the Team Lead, with coverage kept', yesNo()],
    ]),
    ...block('Returns, features & recovery · 7:30–9:00', '21:00', [
      ['Remaining returns complete', yesNo()],
      ['Major end caps replenished'],
      ['Grocery and consumables aisles recovered'],
      ['Damaged merchandise removed; claims staged', count('claims_processed', 'claims', 'Claims staged.')],
    ]),
    ...block('Overnight preparation · 9:00–10:00', '22:00', [
      ['Unneeded carts cleared; backroom pathways accessible', yesNo()],
      ['Existing overstock identified; equipment organized'],
      ['Priority aisles for overnight stocking', text('Which aisles overnight should stock first.')],
    ]),
    ...block('Overnight handoff & final zone · 10:00–11:00', '23:00', [
      ['Overnight supervisor briefed — freight, returns, claims, problem aisles, outs'],
      ['Final recovery and zone', photo('A photo of the department ready for overnight.')],
      ['Trash and cardboard removed'],
      ['Department ready for overnight stocking', yesNo()],
    ]),
  ],
};

const FC_OVERNIGHT: WalmartTemplate = {
  name: 'Food & Consumables — Overnight (10 PM–7 AM)',
  department: 'Food & Consumables',
  period: 'OVERNIGHT',
  description: 'Freight execution, overstock, claims, cleanup, morning handoff.',
  tasks: [
    ...block('Evening handoff & freight setup · 10:00–11:00', '23:00', [
      ['Handoff received; priority aisles and unfinished work reviewed'],
      ['Freight tonight', count('pallets_received', 'pallets', 'Pallets or carts of freight.')],
      ['Associates assigned by aisle and category'],
      ['Freight staged safely; stocking equipment ready'],
      ['Emergency exits and travel paths clear', yesNo()],
    ]),
    ...block('Primary freight · 11:00–2:00', '02:00', [
      ['Freight stocked by aisle', count('cases_stocked', 'cases', 'Cases stocked.')],
      ['Shelf locations verified — nothing plugged', yesNo('No opens a follow-up to correct plugged merchandise.')],
      ['Merchandise rotated where required'],
      ['Cardboard and plastic separated as you go'],
      ['Damaged merchandise and true overstock separated'],
    ]),
    ...LUNCH('Lunch · 2:00–3:00', '03:00'),
    ...block('Complete freight · 3:00–5:00', '05:00', [
      ['Remaining pallets and carts complete', partial()],
      ['Shelves stocked correctly — no plugging'],
      ['Remaining freight consolidated'],
      ['Productivity or freight issues told to the supervisor'],
    ]),
    ...block('Overstock, claims & backroom · 5:00–6:00', '06:00', [
      ['Overstock verified against shelf capacity, labeled and binned', count('overstock_binned', 'cases', 'Cases binned.')],
      ['Damaged merchandise and claims staged', count('claims_processed', 'claims', 'Claims staged.')],
      ['Carts and equipment organized'],
      ['Work areas clean; backroom pathways clear', yesNo()],
    ]),
    ...block('Final zone & morning handoff · 6:00–7:00', '07:00', [
      ['Final zone — merchandise faced and pulled forward', photo('A photo of a zoned aisle.')],
      ['Misplaced product corrected'],
      ['Cardboard, trash, pallets and carts out of customer areas', yesNo()],
      ['Freight left for the morning', count('freight_left', 'pallets', 'Pallets or carts not finished (0 if none).')],
      ['Morning supervisor briefed — unfinished freight, overstock, claims'],
    ]),
  ],
};

/* ===== Meat & Produce ==================================================== */

const MP_MORNING: WalmartTemplate = {
  name: 'Meat & Produce — Morning (6 AM–3 PM)',
  department: 'Meat & Produce',
  period: 'MORNING',
  description: 'Huddle, receiving & processing, stocking & merchandising, food safety, donations — the Team Lead’s checklist built in.',
  tasks: [
    ...block('Start of shift & huddle · 6:00–6:30', '06:30', [
      ['Overnight handoff notes and temperature logs reviewed'],
      ['Walkthrough of meat and produce for readiness'],
      ['Meat case temperature', temp('Meat case °F', MEAT_CASE)],
      ['Produce cooler temperature', temp('Produce cooler °F', COOLER)],
      ['Team huddle — duties assigned for unloading, trimming and stocking'],
      ['Everyone in PPE — gloves, aprons', yesNo()],
      ['Truck ETA', text('When is the truck due?')],
    ]),
    ...block('Receiving & processing · 6:30–9:00', '09:00', [
      ['Delivery unloaded safely'],
      ['Meat delivery temperature', temp('Meat load °F', COLD_LOAD)],
      ['Produce quality and condition on arrival', partial('Partial opens a follow-up to claim what arrived bad.')],
      ['Dates and freshness checked against the delivery documents', yesNo()],
      ['Pallets and cases received and scanned', count('pallets_received', 'pallets', 'Pallets received.')],
      ['Backroom storage labeled, dated and organized by type (FIFO)'],
      ['Non-compliant product claimed', count('claims_processed', 'claims', 'Claims processed.')],
    ]),
    ...block('Stocking & merchandising · 9:00–11:30', '11:30', [
      ['Produce displays stocked — fruit, vegetables, greens, herbs', count('cases_stocked', 'cases', 'Cases stocked.')],
      ['Meat case replenished and rotated', partial()],
      ['Facing, spacing and signage match the planogram', yesNo()],
      ['Promotional and seasonal displays maintained'],
      ['Markdowns and price changes completed', count('items_marked_down', 'items', 'Items marked down.')],
      ['Expired, wilted or discolored product removed', count('items_discarded', 'items', 'Items removed.')],
    ]),
    ...block('Food safety & sanitation · 11:30–12:30', '12:30', [
      ['Midday meat case temperature', temp('Meat case °F', MEAT_CASE)],
      ['Midday produce cooler temperature', temp('Produce cooler °F', COOLER)],
      ['Prep tables, knives and cutting boards sanitized', yesNo()],
      ['Sanitation log complete', yesNo()],
      ['Refrigeration and equipment working', yesNo('No opens a follow-up to report it immediately.')],
    ]),
    ...block('Breaks & coverage · 12:30–1:30', '13:30', [
      ['Breaks approved and scheduled with coverage', yesNo()],
      ['Associates supported through the lunch rush'],
    ]),
    ...block('Donations & shrink · 1:30–2:30', '14:30', [
      ['Donation-eligible product separated, labeled, logged and frozen', count('donations_logged', 'items', 'Items logged for donation.')],
      ['Waste and shrink recorded', yesNo()],
      ['Donation pickup confirmed with management or the partner'],
    ]),
    ...block('End of shift · 2:30–3:00', '15:00', [
      ['Coolers and displays restocked and rotated'],
      ['Prep and cutting areas sanitized and organized'],
      ['Final walkthrough — safety and cleanliness', photo('A photo of the meat and produce floor.')],
      ['Temperature and sanitation logs complete', yesNo()],
    ]),
  ],
};

const MP_EVENING: WalmartTemplate = {
  name: 'Meat & Produce — Evening (2–11 PM)',
  department: 'Meat & Produce',
  period: 'EVENING',
  description: 'Recovery and quality through the evening, markdowns, donations, closing sanitation.',
  tasks: [
    ...block('Start of shift · 2:00–2:30', '14:30', [
      ['Morning handoff reviewed'],
      ['Walkthrough of meat and produce'],
      ['Meat case temperature', temp('Meat case °F', MEAT_CASE)],
      ['Produce cooler temperature', temp('Produce cooler °F', COOLER)],
      ['Duties assigned; everyone in PPE', yesNo()],
    ]),
    ...block('Recovery & quality · 2:30–5:00', '17:00', [
      ['Produce displays recovered and faced'],
      ['Overripe, spoiled or bruised produce removed', count('items_discarded', 'items', 'Items removed.')],
      ['Meat case rotated; discolored product pulled'],
      ['Customers helped — weighing, bagging, special orders'],
    ]),
    ...block('Peak hours · 5:00–7:00', '19:00', [
      ['Associates supported through the evening rush'],
      ['Mid-shift progress checked with each associate'],
      ['Displays full through peak', partial()],
    ]),
    ...block('Breaks & coverage · 7:00–8:00', '20:00', [
      ['Breaks approved and scheduled with coverage', yesNo()],
    ]),
    ...block('Markdowns, donations & shrink · 8:00–9:30', '21:30', [
      ['Markdowns and price changes accurate', count('items_marked_down', 'items', 'Items marked down.')],
      ['Donation product labeled, logged and frozen for pickup', count('donations_logged', 'items', 'Items logged for donation.')],
      ['Waste and shrink recorded', yesNo()],
    ]),
    ...block('Closing sanitation · 9:30–10:30', '22:30', [
      ['Floors swept and mopped'],
      ['Cooler shelves and drains cleaned'],
      ['Tools and utensils washed and sanitized', yesNo()],
      ['Trash, cardboard and pallets removed'],
      ['Closing meat case temperature', temp('Meat case °F', MEAT_CASE)],
      ['Closing produce cooler temperature', temp('Produce cooler °F', COOLER)],
    ]),
    ...block('Close & handoff · 10:30–11:00', '23:00', [
      ['Displays zoned and faced for the morning', photo('A photo of the meat and produce floor.')],
      ['Cooler and prep room doors closed and secure', yesNo()],
      ['Temperature and sanitation logs signed off', yesNo()],
    ]),
  ],
};

export const WALMART_TEMPLATES: WalmartTemplate[] = [
  FD_MORNING,
  FD_EVENING,
  FD_OVERNIGHT,
  FC_MORNING,
  FC_EVENING,
  FC_OVERNIGHT,
  MP_MORNING,
  MP_EVENING,
];

/** The first library's names for these departments — retired when the
 *  Walmart library lands; a store pointed at one moves to its successor. */
export const RETIRED_V1_NAMES: Record<string, { department: string; period: OpsPeriod }> = {
  'Frozen & Dairy — Morning': { department: 'Frozen & Dairy', period: 'MORNING' },
  'Frozen & Dairy — Evening & Receiving': { department: 'Frozen & Dairy', period: 'EVENING' },
  'Frozen & Dairy — Overnight': { department: 'Frozen & Dairy', period: 'OVERNIGHT' },
  'Meat & Produce — Morning': { department: 'Meat & Produce', period: 'MORNING' },
  'Meat & Produce — Team Lead': { department: 'Meat & Produce', period: 'EVENING' },
  'Food & Consumables — Morning': { department: 'Food & Consumables', period: 'MORNING' },
  'Food & Consumables — Evening Recovery': { department: 'Food & Consumables', period: 'EVENING' },
};

/** Labels for the measured outputs. */
export const WALMART_METRIC_LABEL: Record<string, string> = {
  picks_worked: 'Picks worked',
  overstock_binned: 'Overstock binned',
  claims_processed: 'Claims processed',
  returns_worked: 'Returns worked',
  donations_logged: 'Donations logged',
  freight_left: 'Freight left',
};
