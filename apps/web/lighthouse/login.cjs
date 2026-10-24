/**
 * LHCI's puppeteer script: signs the run's persona in once, through the real
 * login page, before the first page is measured. The cookie lives in the
 * Chrome that Lighthouse then drives, so every later page of the run is
 * signed in. Lighthouse's own reset clears caches and service workers
 * between pages (a cold load each time) but never cookies.
 *
 * LHCI_RUN=admin / associate pick the persona; LHCI_RUN=public signs nobody
 * in. The defaults are the dev seed's accounts (apps/api/prisma/seed.ts — the
 * same ones the E2E suite uses); LHCI_<ADMIN|ASSOCIATE>_EMAIL / _PASSWORD
 * override them.
 */
const PERSONAS = {
  admin: {
    email: process.env.LHCI_ADMIN_EMAIL || 'admin@altohr.com',
    password: process.env.LHCI_ADMIN_PASSWORD || 'alto-admin-dev',
  },
  associate: {
    email: process.env.LHCI_ASSOCIATE_EMAIL || 'maria.lopez@example.com',
    password: process.env.LHCI_ASSOCIATE_PASSWORD || 'maria-dev-2026!',
  },
};

let signedIn = false;

/**
 * @param {import('puppeteer-core').Browser} browser
 * @param {{ url: string }} context
 */
module.exports = async function login(browser, { url }) {
  const persona = PERSONAS[process.env.LHCI_RUN || 'public'];
  if (!persona || signedIn) return;

  const origin = new URL(url).origin;
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 30_000 });
    await page.type('input[type="email"]', persona.email);
    await page.type('#login-password', persona.password);
    await Promise.all([
      page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 30_000 }),
      page.keyboard.press('Enter'),
    ]);
    // The session is real only once the API says who this is.
    const me = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const body = res.ok ? await res.json() : null;
      return body && body.user ? body.user.email : `nobody (HTTP ${res.status})`;
    });
    if (me !== persona.email) throw new Error(`sign-in did not stick: /api/auth/me says ${me}`);
    signedIn = true;
    console.log(`[lhci] signed in as ${persona.email}`);
  } finally {
    await page.close();
  }
};
