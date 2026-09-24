import { writeFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import axe from 'axe-core';
import { PERSONAS, signIn } from './personas';

/**
 * Accessibility sweep on the real, running app. The unit-level axe suites
 * render pages against mocked data; this walks the pages a person
 * actually gets, with real data and real chrome, and fails on anything
 * axe rates serious or critical against WCAG 2.1 AA. Lesser findings are
 * attached to the report rather than failing the run, so the bar can
 * rise without a flag day.
 *
 * axe-core is injected from the package already in the tree — no browser
 * extension, no extra dependency.
 */

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server');

interface Finding {
  route: string;
  id: string;
  impact: string | null;
  help: string;
  targets: string[];
  /** What axe measured, where it measures anything — the colour pair and
   *  ratio behind a contrast finding, so the fix needs no second run. */
  detail: string;
}

async function auditRoute(page: Page, route: string): Promise<Finding[]> {
  await page.goto(route);
  await page.waitForTimeout(2000);
  await page.addScriptTag({ content: axe.source });
  const raw = await page.evaluate(async () => {
    const w = window as unknown as { axe: typeof import('axe-core') };
    const r = await w.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      detail: v.nodes
        .slice(0, 3)
        .map((n) => {
          const d = (n.any[0] ?? n.all[0])?.data as
            | { fgColor?: string; bgColor?: string; contrastRatio?: number; fontSize?: string }
            | undefined;
          return d?.contrastRatio ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio} (${d.fontSize})` : '';
        })
        .filter(Boolean)
        .join(' | '),
    }));
  });
  return raw.map((f) => ({ route, ...f }));
}

for (const persona of PERSONAS) {
  test(`no serious or critical accessibility violations (${persona.name})`, async ({ page }, testInfo) => {
    // A dozen routes, each settled and audited: minutes, not the default 30s.
    test.setTimeout(240_000);
    await signIn(page, persona);
    const findings: Finding[] = [];
    for (const route of [...persona.routes, ...persona.axeRoutes]) {
      findings.push(...(await auditRoute(page, route)));
    }
    // Both the report attachment and a file in the test's output dir —
    // the CI failure artifact ships the directory, not the report.
    const body = JSON.stringify(findings, null, 2);
    writeFileSync(testInfo.outputPath(`axe-${persona.name}.json`), body);
    await testInfo.attach(`axe-${persona.name}.json`, { body, contentType: 'application/json' });
    const blocking = findings
      .filter((f) => f.impact === 'serious' || f.impact === 'critical')
      .map(
        (f) =>
          `[${f.route}] ${f.id} (${f.impact}) — ${f.help} @ ${f.targets.join(' | ')}${f.detail ? ` :: ${f.detail}` : ''}`,
      );
    expect(blocking, `axe as ${persona.name}`).toEqual([]);
  });
}
