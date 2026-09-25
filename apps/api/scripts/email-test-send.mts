/**
 * Send a sample of a template to yourself, through the real Resend path,
 * so it can be checked in Gmail on a phone and in Outlook.
 *
 *   railway run --service api -- npx tsx scripts/email-test-send.mts <template|all> <to> [lang]
 *
 * Templates: agreement-reminder, financial-change-confirmation,
 * financial-change-alert, layout-minimal. Lang: en (default), es, tr.
 * Needs RESEND_API_KEY / RESEND_FROM in the environment (Railway has
 * them); locally the stub logs instead of sending.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [template = 'all', to, lang = 'en'] = process.argv.slice(2);
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('usage: npx tsx scripts/email-test-send.mts <template|all> <to> [en|es|tr]');
  process.exit(1);
}
if (lang !== 'en' && lang !== 'es' && lang !== 'tr') {
  console.error('lang must be en, es or tr');
  process.exit(1);
}

// Reuse the preview samples so the test send IS the preview.
const outDir = mkdtempSync(path.join(tmpdir(), 'alto-email-'));
process.argv = [process.argv[0], process.argv[1], outDir];
const { readFileSync, readdirSync } = await import('node:fs');
await import('./email-preview.mts');
const { send } = await import('../src/lib/notifications.js');

const files = readdirSync(outDir).filter((f) => f.endsWith(`.${lang}.html`) && (template === 'all' || f.startsWith(`${template}.`)));
if (files.length === 0) {
  console.error(`no template named ${template}`);
  process.exit(1);
}
for (const f of files) {
  const html = readFileSync(path.join(outDir, f), 'utf8');
  const txt = readFileSync(path.join(outDir, f.replace(/\.html$/, '.txt')), 'utf8');
  const subject = txt.split('\n')[0].replace(/^Subject: /, '');
  const body = txt.split('\n').slice(2).join('\n');
  const r = await send({
    channel: 'EMAIL',
    category: 'email_test_send',
    recipient: { userId: null, phone: null, email: to },
    subject: `[Test] ${subject}`,
    body,
    html,
    audit: false,
  });
  console.log(`${f} → ${to}: ${r.providerMessageId ?? r.externalRef ?? 'sent (stub)'}`);
}
