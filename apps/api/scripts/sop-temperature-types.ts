// Freezer checks that are not typed as temperatures.
//
// OpsLibrary defaults a new task to CHECK and the author picks the type by
// hand, so a task whose whole job is "write down the freezer reading" can
// end up as a CHECK or a NUMBER. Two things follow, and the second is the
// one that matters:
//
//   1. No minus. The store tablet's decimal keypad has no minus key, and
//      until aea6f1a6 the sign toggle only rendered for TEMPERATURE — so
//      a below-zero reading could not be entered at all. That half is now
//      fixed in the UI regardless of type.
//   2. NO ALERT. routes/opsShifts.ts gates the out-of-range flag on
//      `responseType === 'TEMPERATURE'`, and the library only offers
//      tempMin/tempMax for that type. A freezer sitting at +15°F is
//      recorded in silence — nobody is told, and the packet counts it as
//      a temperature check that passed.
//
// The type alone does not restore alerting: a TEMPERATURE task with no
// bounds has nothing to check against. So this reports both, and applies
// bounds only where the title names a case it recognises. Anything it
// cannot place is listed for a human — guessing a band is how a freezer
// ends up alarming at cooler temperatures.
//
// Dry run by default — it reads, prints, and changes nothing:
//   npx -w apps/api tsx scripts/sop-temperature-types.ts
// Retype the ones it is sure of, and set the bands it recognises:
//   npx -w apps/api tsx scripts/sop-temperature-types.ts --apply
// Retype without touching bounds (when the bands are being set by hand):
//   npx -w apps/api tsx scripts/sop-temperature-types.ts --apply --no-bounds
//
// Templates only. A live OpsShift snapshots its checklist when it opens,
// so shifts already running keep the task they started with; the next one
// opened gets the corrected library.

import { PrismaClient, type OpsResponseType } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const NO_BOUNDS = process.argv.includes('--no-bounds');

/**
 * Titles that are asking for a reading.
 *
 * Mentioning a temperature is not the same as taking one, and the first
 * dry run of this script proved it: "Temperature logs complete for the
 * shift", "Lunches approved … with floor and temperature coverage kept"
 * and "handoff notes and temperature logs reviewed" all matched on the
 * word alone. Every one of those is a correctly-typed YES_NO or CHECK,
 * and retyping them would demand a number where there is nothing to
 * measure — a required task with no possible answer blocks the submit,
 * so the supervisor cannot close the shift.
 *
 * So the word has to be there AND the sentence must not be about
 * paperwork, coverage or a sign-off. What survives is the shape of a
 * measurement: "Freezer case temperature", "Check deli cooler temp".
 */
const READS_A_TEMPERATURE =
  /(\btemp(erature)?\b|°\s*[fc]\b|\bdeg(rees)?\b|\bthermometer\b)/i;

/** The sentence is about a record, a rota or an approval — not a reading. */
const ABOUT_THE_PAPERWORK =
  /(\blogs?\b|\bcoverage\b|\bapproved\b|\breviewed\b|\bsigned\b|\bsign[- ]?off\b|\bcomplete[d]?\b|\binspected\b|\bhandoff\b|\btraining\b|\bpolicy\b)/i;

const readsATemperature = (title: string) =>
  READS_A_TEMPERATURE.test(title) && !ABOUT_THE_PAPERWORK.test(title);

/**
 * The bands the Walmart SOP seeds, which are the ones in use. Order
 * matters: "frozen food case" must match the freezer band before the
 * looser case/cooler rule sees it.
 */
const BANDS: Array<{ name: string; test: RegExp; min: number; max: number }> = [
  { name: 'freezer', test: /\b(freezer|frozen)\b/i, min: -30, max: 0 },
  { name: 'meat case', test: /\b(meat|deli|seafood|poultry)\b/i, min: 28, max: 40 },
  { name: 'cooler', test: /\b(cooler|chill|refrigerat|dairy|produce|milk)\b/i, min: 32, max: 40 },
];

const bandFor = (title: string) => BANDS.find((b) => b.test.test(title)) ?? null;

async function main(): Promise<void> {
  const tasks = await prisma.opsSopTemplateTask.findMany({
    where: { responseType: { not: 'TEMPERATURE' } },
    select: {
      id: true,
      title: true,
      section: true,
      responseType: true,
      tempMin: true,
      tempMax: true,
      template: { select: { id: true, name: true, department: true, active: true, retiredAt: true } },
    },
    orderBy: [{ template: { name: 'asc' } }, { section: 'asc' }, { title: 'asc' }],
  });

  const suspect = tasks.filter((t) => readsATemperature(t.title));
  const live = suspect.filter((t) => t.template.active && !t.template.retiredAt);
  const retired = suspect.length - live.length;

  // And the other half of the same problem: already TEMPERATURE, but with
  // no band, so the alert has nothing to fire against.
  const unbounded = await prisma.opsSopTemplateTask.findMany({
    where: {
      responseType: 'TEMPERATURE',
      OR: [{ tempMin: null }, { tempMax: null }],
      template: { active: true, retiredAt: null },
    },
    select: {
      id: true,
      title: true,
      section: true,
      tempMin: true,
      tempMax: true,
      template: { select: { name: true } },
    },
    orderBy: [{ template: { name: 'asc' } }, { title: 'asc' }],
  });

  console.log(`\n=== Mistyped: reads a temperature, typed as something else ===`);
  if (live.length === 0) {
    console.log('  none — every task that names a temperature is typed as one.');
  }
  const placed: Array<{ id: string; min: number; max: number; label: string }> = [];
  for (const t of live) {
    const band = bandFor(t.title);
    const verdict = band
      ? `→ TEMPERATURE, ${band.min}..${band.max}°F (${band.name})`
      : `→ TEMPERATURE, BAND UNKNOWN — set it by hand`;
    console.log(
      `  [${t.responseType.padEnd(6)}] ${t.template.name} · ${t.section} · ${t.title}\n` +
        `            ${verdict}`,
    );
    if (band) placed.push({ id: t.id, min: band.min, max: band.max, label: t.title });
  }
  if (retired > 0) {
    console.log(`  (${retired} more in retired or inactive templates — left alone.)`);
  }

  console.log(`\n=== Typed TEMPERATURE but with no band — records, never alerts ===`);
  if (unbounded.length === 0) console.log('  none.');
  for (const t of unbounded) {
    const band = bandFor(t.title);
    console.log(
      `  ${t.template.name} · ${t.section} · ${t.title}  (min=${t.tempMin ?? '—'} max=${t.tempMax ?? '—'})` +
        (band ? `\n            → suggest ${band.min}..${band.max}°F (${band.name})` : ''),
    );
  }

  const unknown = live.length - placed.length;
  console.log(
    `\n${live.length} mistyped, ${placed.length} with a band this recognises, ` +
      `${unknown} needing a human, ${unbounded.length} typed right but unbounded.`,
  );

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to retype.\n');
    return;
  }

  // Only the ones it can place, and only the fields in question. A task
  // that cannot be placed is left exactly as it was rather than retyped
  // into a TEMPERATURE with no band, which trades a silent count for a
  // silent temperature.
  let changed = 0;
  for (const p of placed) {
    await prisma.opsSopTemplateTask.update({
      where: { id: p.id },
      data: {
        responseType: 'TEMPERATURE' as OpsResponseType,
        ...(NO_BOUNDS ? {} : { tempMin: p.min, tempMax: p.max }),
      },
    });
    changed += 1;
    console.log(`  retyped: ${p.label}`);
  }
  console.log(
    `\n${changed} task${changed === 1 ? '' : 's'} retyped${NO_BOUNDS ? ' (bounds untouched)' : ' with their bands'}. ` +
      `${unknown} left for a human.\n`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
