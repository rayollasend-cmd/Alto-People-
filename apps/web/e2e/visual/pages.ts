import type { Page } from '@playwright/test';
import { ASSOCIATE, WALK_PERSONAS, type WalkPersona } from '../walkPersonas';

/**
 * The pages the visual regression suite holds to an approved picture.
 *
 * Each page is recorded once (record.spec.ts: every /api response into
 * hars/<key>.har) and replayed from that recording (visual.spec.ts), so the
 * picture depends on the code alone — never on what the database holds that
 * day. Desktop is 1440×900 and phone 390×844; every page is shot in dark,
 * and the first three in light as well.
 */

export type Form = 'desktop' | 'phone';
export type Theme = 'dark' | 'light';

export const FORMS: Record<Form, { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean; deviceScaleFactor: number }> = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
};

/** Who a page is recorded as. `public` signs nobody in. */
export type PersonaKey = 'public' | 'admin' | 'associate' | 'portal-store';

const persona = (key: string): WalkPersona => {
  const p = key === ASSOCIATE.key ? ASSOCIATE : WALK_PERSONAS.find((x) => x.key === key);
  if (!p) throw new Error(`visual: no walk persona ${key} in e2e/walkPersonas.ts`);
  return p;
};

export const PERSONAS: Record<Exclude<PersonaKey, 'public'>, WalkPersona> = {
  admin: persona('admin'),
  associate: persona('associate'),
  'portal-store': persona('portal-store'),
};

export interface VisualPage {
  /** File stem for the HAR and the screenshots. */
  key: string;
  title: string;
  persona: PersonaKey;
  /**
   * Where the page lives. A function finds it at recording time (a client's
   * or a person's id differs between databases); the URL it lands on is
   * saved in hars/manifest.json and the replay opens exactly that.
   */
  route: string | ((page: Page) => Promise<string>);
  forms: Form[];
  themes: Theme[];
}

/** The href of the first link whose name matches, read off a list page. */
async function hrefOf(page: Page, listRoute: string, name: RegExp, prefix: string): Promise<string> {
  await page.goto(listRoute);
  const link = page.locator(`a[href^="${prefix}"]`).filter({ hasText: name }).first();
  await link.waitFor({ timeout: 30_000 });
  const href = await link.getAttribute('href');
  if (!href) throw new Error(`visual: no ${prefix} link named ${name} on ${listRoute}`);
  // The record page itself, without any tab or filter the list carried.
  return new URL(href, 'http://x').pathname;
}

const BOTH: Form[] = ['desktop', 'phone'];

export const VISUAL_PAGES: VisualPage[] = [
  { key: 'login', title: 'Sign in', persona: 'public', route: '/login', forms: BOTH, themes: ['dark', 'light'] },
  { key: 'admin-home', title: 'Admin home', persona: 'admin', route: '/', forms: BOTH, themes: ['dark', 'light'] },
  { key: 'clients', title: 'Clients list', persona: 'admin', route: '/clients', forms: BOTH, themes: ['dark', 'light'] },
  {
    key: 'client-overview',
    title: "A client's Overview",
    persona: 'admin',
    route: (page) => hrefOf(page, '/clients', /Coastal Resort/i, '/clients/'),
    forms: BOTH,
    themes: ['dark'],
  },
  { key: 'people', title: 'People list', persona: 'admin', route: '/people', forms: BOTH, themes: ['dark'] },
  {
    key: 'person-record',
    title: "A person's record",
    persona: 'admin',
    route: (page) => hrefOf(page, '/people', /Maria Lopez/i, '/people/'),
    forms: BOTH,
    themes: ['dark'],
  },
  { key: 'scheduling-week', title: 'Scheduling (week)', persona: 'admin', route: '/scheduling?view=week', forms: BOTH, themes: ['dark'] },
  { key: 'time-attendance', title: 'Time & attendance', persona: 'admin', route: '/time-attendance', forms: BOTH, themes: ['dark'] },
  { key: 'payroll', title: 'Payroll home', persona: 'admin', route: '/payroll', forms: BOTH, themes: ['dark'] },
  { key: 'books', title: 'Books home', persona: 'admin', route: '/books', forms: BOTH, themes: ['dark'] },
  { key: 'approvals', title: 'Approvals', persona: 'admin', route: '/approvals', forms: BOTH, themes: ['dark'] },
  { key: 'users-access', title: 'Settings › Users & access', persona: 'admin', route: '/admin/users', forms: BOTH, themes: ['dark'] },
  { key: 'associate-home', title: "The associate's home", persona: 'associate', route: '/', forms: ['phone'], themes: ['dark'] },
  { key: 'portal-home', title: 'Store portal home', persona: 'portal-store', route: '/portal', forms: BOTH, themes: ['dark'] },
];

/** Screenshot file name for one page, form and theme. */
export const shotName = (key: string, form: Form, theme: Theme) => `${key}-${form}-${theme}.png`;

/** The recording beside the HARs: when each page was recorded and with what. */
export interface VisualManifest {
  note: string;
  pages: Record<
    string,
    {
      /** The URL the page was recorded at (path + query). */
      url: string;
      /** The recording instant; the replay freezes the browser clock here. */
      recordedAt: string;
      /** localStorage as the page left it (dismissed tours and the like), restored before load. */
      localStorage: Record<string, string>;
    }
  >;
}
