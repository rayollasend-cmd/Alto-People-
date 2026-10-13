import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { PERSONAS, signIn } from './personas';

/**
 * Brief 2-1b acceptance — the hotel's journey in the browser.
 *
 *   The tenant becomes a direct employer (a hotel: no clients, no bill
 *   rates, no housing, no vans), gets a region and a property, hires a
 *   team member, schedules a shift, and the admin then opens every screen
 *   of the journey. On each screen the visible text and the labels carry
 *   none of the words a hotel must never see. The list below IS the rule;
 *   nothing in prose overrides it.
 *
 *   Full stack only (E2E_BASE_URL at a running app with the dev seed).
 *   The dev database is shared with the specs that run after this one, so
 *   the tenant is handed back to Alto HR's profile and name at the end,
 *   whatever happened.
 */

const FORBIDDEN = ['client', 'bill rate', 'housing', 'van', 'store', 'associate', 'alto'] as const;

/**
 * Exemptions, each with its reason:
 *  - "Alto People": the product name Hugo states in his introduction, by the
 *    owner's direction; whether it is exempt from the hotel's rule is the
 *    owner's pending ruling. Removed from the text before the check.
 *  - the admin's own address "admin@altohr.com" needs no exemption: "alto"
 *    inside "altohr" is not a whole word and the check is on word
 *    boundaries (the spec verifies this below).
 */
const EXEMPT_PHRASES = ['Alto People'];

const admin = PERSONAS.find((p) => p.name === 'admin')!;

/** Every forbidden word in a text, singular or plural, with context. */
export function forbiddenHits(route: string, text: string): string[] {
  let t = text;
  for (const phrase of EXEMPT_PHRASES) t = t.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  const hits: string[] = [];
  for (const word of FORBIDDEN) {
    const re = new RegExp(`\\b${word.replace(/ /g, '\\s+')}(?:e?s)?\\b`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const from = Math.max(0, m.index - 40);
      const to = Math.min(t.length, m.index + m[0].length + 40);
      hits.push(`${route}: ${word} — …${t.slice(from, to).replace(/\s+/g, ' ')}…`);
      if (hits.length > 200) return hits;
    }
  }
  return hits;
}

/** The text a person can see: the body's text plus the labels assistive tech reads. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.body.innerText];
    for (const el of Array.from(document.querySelectorAll('[aria-label],[title],[placeholder],img[alt]'))) {
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

/**
 * The app polls (notifications, unread messages), so "network idle" never
 * comes on a signed-in page; the screen is settled when main is visible and
 * no loading state remains, with a bounded wait either way.
 */
async function settle(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByRole('main').first()).toBeVisible({ timeout: 20_000 });
  await page
    .locator('[aria-busy="true"], [role="progressbar"], [data-loading="true"]')
    .first()
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
}

async function call<T = unknown>(api: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const res = await api.fetch(`/api${path}`, { method, data, timeout: 30_000 });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

test.skip(!process.env.E2E_FULLSTACK, 'needs the API dev server (set E2E_FULLSTACK=1)');
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

test('the hotel sees no client, bill rate, housing, van, store, associate or Alto on any screen of its journey', async ({ page }) => {
  await signIn(page, admin);
  const api = page.request;
  const hits: string[] = [];
  const stamp = Date.now().toString(36);

  // The rule's boundaries, proven before the walk: a word inside another is not a hit.
  expect(forbiddenHits('x', 'admin@altohr.com relevant advance restore')).toEqual([]);
  expect(forbiddenHits('x', 'Our clients and the van').length).toBe(2);

  try {
    await call(api, 'PUT', '/admin/tenant/profile', { businessModel: 'DIRECT_EMPLOYER', resetToDefaults: true });
    await call(api, 'PATCH', '/admin/org/settings', { orgName: 'The Grand Hotel' });

    const region = await call<{ unit: { id: string } }>(api, 'POST', '/admin/org-units', { type: 'REGION', name: 'Gulf Coast' });
    const site = await call<{ site: { id: string } }>(api, 'POST', '/admin/sites', {
      name: 'The Grand Hotel',
      timezone: 'America/Chicago',
      state: 'FL',
      orgUnitId: region.unit.id,
    });

    // An org-wide onboarding template, found or made.
    const list = await call<{ templates: Array<{ id: string; clientId: string | null }> }>(api, 'GET', '/onboarding/templates');
    let templateId = list.templates.find((t) => t.clientId === null)?.id ?? null;
    if (!templateId) {
      const made = await call<{ id: string }>(api, 'POST', '/onboarding/templates', {
        name: 'Hotel standard',
        track: 'STANDARD',
        clientId: null,
        tasks: [{ kind: 'PROFILE_INFO', title: 'Profile', order: 0 }],
      });
      templateId = made.id;
    }

    // The hire: invited with no client, placed by the property, every checklist task skipped by HR, approved.
    const invite = await call<{ id: string }>(api, 'POST', '/onboarding/applications', {
      associateEmail: `tess.member.${stamp}@example.com`,
      associateFirstName: 'Tess',
      associateLastName: `Member${stamp}`,
      templateId,
      locationId: site.site.id,
      position: 'Housekeeper',
    });
    const detail = await call<{ associateId: string; tasks: Array<{ id: string; status: string }> }>(api, 'GET', `/onboarding/applications/${invite.id}`);
    for (const task of detail.tasks) {
      if (task.status === 'DONE' || task.status === 'SKIPPED') continue;
      await call(api, 'POST', `/onboarding/applications/${invite.id}/tasks/${task.id}/skip`); // 204, no body
    }
    await call(api, 'POST', `/onboarding/applications/${invite.id}/approve`, { hireDate: new Date().toISOString().slice(0, 10), acknowledgeWarnings: true });

    // A shift at the property, no client named.
    const startsAt = new Date(Date.now() + 2 * 86_400_000);
    startsAt.setUTCHours(14, 0, 0, 0);
    await call(api, 'POST', '/scheduling/shifts', {
      locationId: site.site.id,
      position: 'Housekeeper',
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(),
      status: 'OPEN',
    });

    const routes = [
      '/',
      '/people',
      `/people?associateId=${detail.associateId}&tab=employment`,
      '/scheduling',
      '/time-attendance',
      '/hr-cases',
      '/payroll',
      '/admin/organization',
      '/admin/sites',
      '/admin/org-units',
      '/admin/employers',
      '/settings',
    ];
    const seen = new Map<string, string>();
    for (const route of routes) {
      await settle(page, route);
      const text = await visibleText(page);
      seen.set(route, text);
      hits.push(...forbiddenHits(route, text));
    }

    // The journey's facts are on the screens.
    expect(seen.get('/people'), 'the hire is listed').toMatch(new RegExp(`Member${stamp}`));
    expect(seen.get('/people'), 'people are called by the hotel\'s word').toMatch(/team member/i);
    expect(seen.get('/admin/sites'), 'the property is listed as a property').toMatch(/The Grand Hotel[\s\S]*Property/i);
  } finally {
    // Alto HR gets its profile and its name back for the specs that follow.
    await api.fetch('/api/admin/tenant/profile', { method: 'PUT', data: { businessModel: 'WORKFORCE_PROVIDER', resetToDefaults: true }, timeout: 30_000 });
    await api.fetch('/api/admin/org/settings', { method: 'PATCH', data: { orgName: 'Alto HR' }, timeout: 30_000 });
  }

  expect(hits, `forbidden words on the hotel's screens:\n${hits.join('\n')}`).toEqual([]);
});
