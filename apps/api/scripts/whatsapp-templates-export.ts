/**
 * Brief 2-1b — the WhatsApp templates as Meta needs them, for registration
 * in WhatsApp Manager (one template per language; the texts are the
 * registration, so a wording change is a new name).
 *
 *   npx tsx scripts/whatsapp-templates-export.ts            a readable list
 *   npx tsx scripts/whatsapp-templates-export.ts --json     the submission payloads
 *
 * The tenant's display name and the assistant's name are positional
 * parameters like every other value, so one registered template serves
 * every tenant.
 */
import { WA_TEMPLATES, type WaLang } from '../src/lib/whatsappContent.js';

const META_LANG: Record<WaLang, string> = { en: 'en_US', es: 'es', tr: 'tr' };
const SAMPLE: Record<string, string> = {
  subject: 'Schedule update',
  message: 'Your Saturday shift moved to 9:00.',
  'shift label': 'Morning',
  store: 'Pier Park',
  'day and time': 'Sat 9:00–17:00',
  'new time': '10:00–18:00',
  'van name': 'Van 1',
  'pickup time': '8:15',
  minutes: '5',
  'pay date': 'Fri Oct 17',
  period: 'Oct 4–Oct 10',
  title: 'Hurricane watch',
  body: 'All shifts on Thursday are cancelled.',
  orgName: 'Alto HR',
  assistantName: 'Hugo',
};

const payloads = WA_TEMPLATES.flatMap((t) => {
  const names = [...t.params, ...(t.brandParams ?? [])];
  return (Object.keys(t.body) as WaLang[]).map((lang) => ({
    name: t.metaName,
    language: META_LANG[lang],
    category: t.metaCategory,
    components: [
      {
        type: 'BODY',
        text: t.body[lang],
        example: { body_text: [names.map((n) => SAMPLE[n] ?? n)] },
      },
    ],
    parameters: names,
  }));
});

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(payloads, null, 2) + '\n');
} else {
  for (const t of WA_TEMPLATES) {
    const names = [...t.params, ...(t.brandParams ?? [])];
    console.log(`${t.metaName}  [${t.metaCategory}]  params: ${names.map((n, i) => `{{${i + 1}}}=${n}`).join(', ')}`);
    for (const lang of Object.keys(t.body) as WaLang[]) console.log(`  ${META_LANG[lang].padEnd(5)} ${t.body[lang].replace(/\n+/g, ' / ')}`);
    console.log('');
  }
  console.log(`${WA_TEMPLATES.length} templates, ${payloads.length} language versions. Submit each in WhatsApp Manager under the name shown; approval takes days.`);
}
