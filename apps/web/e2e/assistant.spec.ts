import { test, expect, type Page } from '@playwright/test';

/**
 * One assistant, one place: the spark in the top bar (and ⌘J) opens a pane
 * beside the page that stays open while the person moves around, with one
 * thread. The API is mocked at the network layer.
 */

const U1 = '33333333-3333-4333-8333-333333333333';
const user = {
  id: U1, email: 'hr@example.com', role: 'HR_ADMINISTRATOR', primaryRole: 'HR_ADMINISTRATOR', availableRoles: ['HR_ADMINISTRATOR'],
  status: 'ACTIVE', clientId: null, clientName: null, locationId: null, locationName: null, regionId: null, regionName: null,
  associateId: null, firstName: 'Hana', lastName: 'Ruiz', photoUrl: null, timezone: null, language: null, mfaEnabled: false,
};

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname.replace(/^\/api/, '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (p === '/auth/me') return json({ user });
    if (p === '/auth/me/nav-pins') return json({ pinned: [] });
    if (p === '/hugo') return json({ name: 'Hugo', audience: 'admin', intro: "I'm Hugo, the AI assistant here. I'm not a person.", can: [{ key: 'DESK', label: 'What waits on your desk', example: 'What is waiting on me?' }], model: true });
    if (p === '/hugo/ask' && req.method() === 'POST') {
      const body = req.postDataJSON() as { text: string; page?: { path: string; title?: string } };
      return json({ intent: 'MODEL', reply: `You asked "${body.text}" from ${body.page?.title ?? body.page?.path ?? 'nowhere'}.`, linkUrl: '/approvals', handoff: null, source: 'model' });
    }
    if (p === '/me/inbox') return json({ total: 0, sources: [] });
    if (p === '/clients') return json({ clients: [], nextCursor: null });
    if (p === '/people/directory') return json({ associates: [], nextCursor: null });
    return json({ error: { code: 'not_found', message: 'not mocked' } }, 404);
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
});

test('the spark opens the pane; it knows the page; the thread survives moving pages; ⌘J closes it', async ({ page }) => {
  await page.goto('/people');
  // The page names itself once its header mounts; ask after that.
  await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /^ask hugo/i }).click();
  const pane = page.getByTestId('assistant-pane');
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'What is waiting on me?' }).click();
  await expect(pane.getByText(/You asked "What is waiting on me\?" from People/)).toBeVisible();
  await expect(pane.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/approvals');

  // Still open, same thread, on another page.
  await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: /^home$/i }).click();
  await expect(pane).toBeVisible();
  await expect(pane.getByText(/You asked "What is waiting on me\?"/)).toBeVisible();

  await page.keyboard.press('Meta+J');
  await expect(page.getByTestId('assistant-pane')).toHaveCount(0);
  await page.screenshot({ path: 'e2e-results/assistant-pane.png' });
});
