/**
 * Render email templates to files so they can be looked at in a browser,
 * measured, and screenshotted.
 *
 *   npx tsx scripts/email-preview.mts <outDir> [template]
 *
 * Writes <template>.<lang>.html and .txt for every language, and prints
 * the HTML size of each. Needs no database: the branding snapshot falls
 * back to the shipped defaults.
 */
process.env.DATABASE_URL ??= 'postgresql://preview:preview@localhost:5432/preview';
process.env.JWT_SECRET ??= 'preview-only-secret-that-is-at-least-forty-four-characters-long';
process.env.PAYOUT_ENCRYPTION_KEY ??= 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';
process.env.APP_BASE_URL ??= 'https://people.altohr.com';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [outDir = 'email-previews', only] = process.argv.slice(2);
const { agreementReminderEmail, financialChangeConfirmationEmail, financialChangeAlertEmail } = await import('../src/lib/emailContent.js');
const { renderBrandedEmail } = await import('../src/lib/emailLayout.js');

type Rendered = { subject: string; html: string; text: string; htmlBytes: number };
const samples: Record<string, (lang: 'en' | 'es' | 'tr') => Rendered> = {
  'agreement-reminder': (lang) =>
    agreementReminderEmail({
      lang,
      firstName: 'Maria',
      kind: 'EMPLOYMENT_OFFER',
      issuedAt: new Date('2026-09-14T14:05:00Z'),
      signBy: new Date('2026-10-05T04:00:00Z'),
      employerName: 'Walmart Supercenter #1234',
      refId: 'ALT-PREVIEW-0001',
    }),
  'financial-change-confirmation': (lang) =>
    financialChangeConfirmationEmail({
      lang,
      firstName: 'Maria',
      kind: 'BANK_ACCOUNT',
      newSummary: 'Chase · checking · ending 6789',
      when: new Date('2026-09-24T14:05:00Z'),
      byAdmin: false,
      refId: 'ALT-PREVIEW-0003',
    }),
  'financial-change-alert': () =>
    financialChangeAlertEmail({
      change: {
        id: '3f1c2b7e-0000-4000-8000-000000000001',
        kind: 'BANK_ACCOUNT',
        source: 'SELF',
        onBehalf: false,
        oldSummary: 'Regions · savings · ending 1111',
        newSummary: 'Chase · checking · ending 6789',
        ip: '73.54.120.9',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
        authStrength: 'PASSWORD',
        riskFlags: ['contact_changed_recently', 'weak_sign_in'],
        riskScore: 4,
        highRisk: true,
        status: 'HELD',
        verifyPhoneLast4: '0142',
        createdAt: new Date('2026-09-24T14:05:00Z'),
      },
      associateName: 'Maria Lopez',
      actorName: 'Maria Lopez',
    }),
  'layout-minimal': (lang) =>
    renderBrandedEmail({
      lang,
      subject: 'A minimal message',
      preheader: 'One heading, one paragraph, no button.',
      greeting: null,
      heading: 'A minimal message',
      paragraphs: ['This is what the layout looks like with nothing but a paragraph.'],
      refId: 'ALT-PREVIEW-0002',
    }),
};

mkdirSync(outDir, { recursive: true });
const rows: string[] = [];
for (const [name, build] of Object.entries(samples)) {
  if (only && name !== only) continue;
  for (const lang of ['en', 'es', 'tr'] as const) {
    const r = build(lang);
    writeFileSync(path.join(outDir, `${name}.${lang}.html`), r.html);
    writeFileSync(path.join(outDir, `${name}.${lang}.txt`), `Subject: ${r.subject}\n\n${r.text}`);
    rows.push(`${name}.${lang}\t${(r.htmlBytes / 1024).toFixed(1)} KB\t${r.subject}`);
  }
}
console.log(rows.join('\n'));
