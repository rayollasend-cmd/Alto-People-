import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/**
 * The people the full-stack sweeps sign in as. Personas see entirely
 * different pages (the original "swing" overflow bug was admin-only while
 * every associate page was clean), so every guard runs once per persona.
 * DIAG_USER / DIAG_PASS override the associate for ad-hoc local runs.
 *
 * Sign-in is cached per persona for the run: the API rate-limits login
 * attempts per email, and a suite of sweeps (each with its retries) that
 * all sign in as Maria trips it. The first test to need a persona logs
 * in and saves the storage state; later tests restore the cookies.
 */
export interface Persona {
  name: string;
  email: string;
  pass: string;
  /** Routes every guard walks. */
  routes: string[];
  /** Routes the axe sweep adds on top — pages that are read more than
   *  they are scrolled, where an overflow guard has nothing to say. */
  axeRoutes: string[];
}

export const PERSONAS: Persona[] = [
  {
    name: 'associate',
    email: process.env.DIAG_USER ?? 'maria.lopez@example.com',
    pass: process.env.DIAG_PASS ?? 'maria-dev-2026!',
    routes: ['/', '/scheduling', '/time-attendance', '/time-off', '/payroll'],
    axeRoutes: ['/me', '/settings', '/whats-new', '/help-center'],
  },
  {
    name: 'admin',
    email: 'admin@altohr.com',
    pass: 'alto-admin-dev',
    routes: ['/', '/scheduling', '/time-attendance', '/time-off', '/people', '/payroll', '/approvals'],
    axeRoutes: ['/onboarding', '/clients', '/documents', '/ops', '/analytics', '/product-analytics', '/whats-new', '/settings'],
  },
];

const STATE_DIR = 'e2e-results/state';
const statePath = (persona: Persona) => `${STATE_DIR}/${persona.name}.json`;

export async function signIn(page: Page, persona: Persona): Promise<void> {
  const path = statePath(persona);
  if (existsSync(path)) {
    const state = JSON.parse(readFileSync(path, 'utf8')) as { cookies?: Parameters<Page['context']>[0] };
    const cookies = (state as { cookies?: unknown }).cookies as Parameters<ReturnType<Page['context']>['addCookies']>[0] | undefined;
    if (cookies && cookies.length > 0) {
      await page.context().addCookies(cookies);
      await page.goto('/');
      await page.waitForTimeout(1500);
      return;
    }
  }
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(persona.email);
  await page.getByLabel(/^password/i).fill(persona.pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3000);
  mkdirSync(STATE_DIR, { recursive: true });
  await page.context().storageState({ path });
}
