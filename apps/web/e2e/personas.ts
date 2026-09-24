import type { Page } from '@playwright/test';

/**
 * The people the full-stack sweeps sign in as. Personas see entirely
 * different pages (the original "swing" overflow bug was admin-only while
 * every associate page was clean), so every guard runs once per persona.
 * DIAG_USER / DIAG_PASS override the associate for ad-hoc local runs.
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

export async function signIn(page: Page, persona: Persona): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(persona.email);
  await page.getByLabel(/^password/i).fill(persona.pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(3000);
}
