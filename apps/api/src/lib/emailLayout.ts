import { env } from '../config/env.js';
import { getBrandingSync } from './branding.js';

/**
 * THE ONE EMAIL LAYOUT.
 *
 * Every transactional email Alto sends renders through this: a navy header
 * with the hosted logo and the wordmark as real text, a thin gold rule, a
 * white card with one headline, one or two sentences, an optional summary
 * block and one button, and a short footer with the legal name, address,
 * phone, one support address, the security line and a reference id.
 *
 * Built for the inboxes people actually use:
 *   - tables with role="presentation" and inline CSS, 600px wide, fluid
 *     under 620px, readable at 375px
 *   - the logo is a hosted PNG on our own domain with width, height and
 *     alt — never base64 (which is what made Gmail clip the old emails)
 *   - the header background is a hosted 1×1 navy image on top of a navy
 *     bgcolor (with VML for Outlook), because Gmail's dark mode inverts
 *     colours but never images: the navy stays navy
 *   - a "bulletproof" button: VML roundrect for Outlook, a padded anchor
 *     everywhere else, no images
 *   - color-scheme meta tags, a dark-mode stylesheet for Apple Mail and
 *     Outlook.com, and the same rules under Gmail Android's [data-ogsc]
 *   - a hidden preheader, a lang attribute, and a plain-text twin
 *
 * Chrome strings exist in English, Spanish and Turkish; a template picks
 * the language, the layout follows.
 */

export type EmailLang = 'en' | 'es' | 'tr';

export interface EmailSummaryRow {
  label: string;
  value: string;
}

export interface BrandedEmailOpts {
  lang?: EmailLang;
  /** Sentence case, specific, never a code or password. */
  subject: string;
  /** The inbox preview line, ≤ 110 characters. */
  preheader: string;
  /** "Hi Maria," — null for no greeting. */
  greeting?: string | null;
  /** Short, sentence case: "Your employment offer is waiting for your signature". */
  heading: string;
  /** One to three short paragraphs, plain text. */
  paragraphs: string[];
  /** Name and key details, when there are any. */
  summary?: EmailSummaryRow[];
  /** The one action. */
  cta?: { label: string; url: string } | null;
  /** Anything that belongs after the button (what happens next, how long a link lasts). */
  after?: string[];
  /** Reference id shown in the footer; generated when omitted. */
  refId?: string;
  /** A template that must NOT carry the default security line passes its own (the clock-in code email). */
  securityLine?: string | null;
}

export interface RenderedEmail {
  subject: string;
  /** The headline — also the one-line body the in-app bell shows. */
  heading: string;
  html: string;
  text: string;
  /** Bytes of the HTML — every template is held under 80 KB by a test. */
  htmlBytes: number;
}

/* ---- brand constants ---------------------------------------------------- */

export const NAVY = '#0B1B3A';
export const GOLD = '#C9A84C';
const INK = '#111827';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const WASH = '#F3F4F6';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const COMPANY = {
  legalName: 'Alto Etho LLC d/b/a Alto HR',
  brand: 'Alto HR',
  address: '495 Grand Boulevard, Suite 206, Miramar Beach FL 32550',
  phone: '(850) 805-3774',
  phoneHref: 'tel:+18508053774',
  supportEmail: 'info@altohr.com',
} as const;

const CHROME: Record<EmailLang, { security: string; questions: (email: string) => string; reference: string; sentBy: string }> = {
  en: {
    security: 'We will never ask for your password or Social Security number by email.',
    questions: (e) => `Questions? Email ${e}.`,
    reference: 'Reference',
    sentBy: 'Sent by Alto HR',
  },
  es: {
    security: 'Nunca le pediremos su contraseña ni su número de Seguro Social por correo electrónico.',
    questions: (e) => `¿Preguntas? Escríbanos a ${e}.`,
    reference: 'Referencia',
    sentBy: 'Enviado por Alto HR',
  },
  tr: {
    security: 'E-posta yoluyla asla parolanızı veya Sosyal Güvenlik numaranızı istemeyiz.',
    questions: (e) => `Sorularınız için ${e} adresine yazın.`,
    reference: 'Referans',
    sentBy: 'Alto HR tarafından gönderildi',
  },
};

/* ---- links always point at the public app ------------------------------- */

/**
 * The public base every email link uses. A Railway hostname in APP_BASE_URL
 * is a deployment detail, not an address a recipient should ever see or
 * click; in production it is rewritten to people.altohr.com.
 */
export function publicBaseUrl(): string {
  const raw = (env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (env.NODE_ENV === 'production' && (/\.railway\.app$/i.test(hostOf(raw)) || !raw.startsWith('https://'))) {
    return 'https://people.altohr.com';
  }
  return raw || 'https://people.altohr.com';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Absolute URL for an in-app path. */
export function appLink(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${publicBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** The hosted logo: a 256×256 PNG (16 KB) shipped with the web build, served from our own domain. */
export function logoUrl(): string {
  return `${publicBaseUrl()}/email/logo.png`;
}

function headerImageUrl(): string {
  return `${publicBaseUrl()}/email/navy.png`;
}

/* ---- helpers --------------------------------------------------------------- */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function makeRefId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ALT-${ts}-${rand}`;
}

function supportEmail(): string {
  const b = getBrandingSync();
  return b.supportEmail ?? env.RESEND_REPLY_TO ?? COMPANY.supportEmail;
}

function brandName(): string {
  return getBrandingSync().orgName || COMPANY.brand;
}

function para(text: string, extra = ''): string {
  return `<p class="ink" style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:${INK}${extra}">${escapeHtml(text)}</p>`;
}

function summaryHtml(rows: EmailSummaryRow[]): string {
  const trs = rows
    .map(
      (r, i) => `
        <tr>
          <td class="muted" style="padding:${i === 0 ? 0 : 8}px 16px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td>
          <td class="ink" style="padding:${i === 0 ? 0 : 8}px 0 0;font-family:${FONT};font-size:15px;line-height:20px;color:${INK};font-weight:600;vertical-align:top">${escapeHtml(r.value)}</td>
        </tr>`,
    )
    .join('');
  return `
      <table role="presentation" class="summary" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px;background-color:${WASH};border-radius:6px">
        <tr><td style="padding:16px 20px"><table role="presentation" cellspacing="0" cellpadding="0" border="0">${trs}</table></td></tr>
      </table>`;
}

function buttonHtml(cta: { label: string; url: string }): string {
  const url = escapeHtml(cta.url);
  const label = escapeHtml(cta.label);
  return `
      <table role="presentation" class="btn" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 24px">
        <tr>
          <td align="center" bgcolor="${NAVY}" style="border-radius:6px;background-color:${NAVY}">
            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="12%" strokecolor="${NAVY}" fillcolor="${NAVY}"><w:anchorlock/><center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
            <!--[if !mso]><!--><a href="${url}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:6px;background-color:${NAVY};border:1px solid ${NAVY}">${label}</a><!--<![endif]-->
          </td>
        </tr>
      </table>`;
}

/* ---- the layout ------------------------------------------------------------ */

export function renderBrandedEmail(o: BrandedEmailOpts): RenderedEmail {
  const lang = o.lang ?? 'en';
  const chrome = CHROME[lang];
  const refId = o.refId ?? makeRefId();
  const support = supportEmail();
  const brand = brandName();
  const security = o.securityLine === undefined ? chrome.security : o.securityLine;
  const preheader = escapeHtml(o.preheader.slice(0, 110));
  const logo = escapeHtml(logoUrl());
  const headerBg = escapeHtml(headerImageUrl());

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<title>${escapeHtml(o.subject)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{color:${NAVY}}
@media only screen and (max-width:620px){
  .wrap{width:100%!important;max-width:100%!important}
  .pad{padding-left:20px!important;padding-right:20px!important}
  .h1{font-size:22px!important;line-height:28px!important}
  .btn{width:100%!important}
  .btn a{display:block!important;box-sizing:border-box!important;text-align:center!important}
}
@media (prefers-color-scheme:dark){
  .bg{background-color:#0F172A!important}
  .card{background-color:#1E293B!important}
  .ink{color:#E2E8F0!important}
  .muted{color:#94A3B8!important}
  .rule{border-top-color:#334155!important}
  .summary{background-color:#0F172A!important}
  a.plain{color:#93C5FD!important}
  .btn td{background-color:#FFFFFF!important}
  .btn a{background-color:#FFFFFF!important;color:#0B1B3A!important;border-color:#FFFFFF!important}
}
[data-ogsc] .bg{background-color:#0F172A!important}
[data-ogsc] .card{background-color:#1E293B!important}
[data-ogsc] .ink{color:#E2E8F0!important}
[data-ogsc] .muted{color:#94A3B8!important}
[data-ogsc] .rule{border-top-color:#334155!important}
[data-ogsc] .summary{background-color:#0F172A!important}
[data-ogsc] .btn td{background-color:#FFFFFF!important}
[data-ogsc] .btn a{background-color:#FFFFFF!important;color:#0B1B3A!important;border-color:#FFFFFF!important}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:${WASH}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${preheader}${'&#847;&zwnj;&nbsp;'.repeat(24)}</div>
<table role="presentation" class="bg" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${WASH}">
  <tr>
    <td align="center" style="padding:24px 12px">
      <!--[if mso]><table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center"><tr><td><![endif]-->
      <table role="presentation" class="wrap" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px">
        <tr>
          <td class="pad" bgcolor="${NAVY}" background="${headerBg}" style="background-color:${NAVY};background-image:url('${headerBg}');background-repeat:repeat;border-radius:8px 8px 0 0;padding:20px 40px">
            <!--[if gte mso 9]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:600px;"><v:fill type="tile" src="${headerBg}" color="${NAVY}"/><v:textbox inset="0,0,0,0"><![endif]-->
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="padding-right:12px;vertical-align:middle"><img src="${logo}" width="40" height="40" alt="${escapeHtml(brand)} logo" style="display:block;width:40px;height:40px;border-radius:8px"></td>
                <td style="font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:#FFFFFF;letter-spacing:0.02em;vertical-align:middle">${escapeHtml(brand)}</td>
              </tr>
            </table>
            <!--[if gte mso 9]></v:textbox></v:rect><![endif]-->
          </td>
        </tr>
        <tr><td bgcolor="${GOLD}" style="background-color:${GOLD};height:3px;font-size:1px;line-height:1px">&nbsp;</td></tr>
        <tr>
          <td class="card pad" bgcolor="#FFFFFF" style="background-color:#FFFFFF;padding:32px 40px 8px">
            ${o.greeting ? para(o.greeting) : ''}
            <h1 class="h1 ink" style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:600;color:${INK}">${escapeHtml(o.heading)}</h1>
            ${o.paragraphs.map((p) => para(p)).join('')}
            ${o.summary && o.summary.length ? summaryHtml(o.summary) : ''}
            ${o.cta ? buttonHtml(o.cta) : ''}
            ${(o.after ?? []).map((p) => para(p, `;font-size:15px;line-height:22px`)).join('')}
          </td>
        </tr>
        <tr>
          <td class="card pad rule" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-top:1px solid ${RULE};border-radius:0 0 8px 8px;padding:20px 40px 24px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED}">
            <div class="muted" style="color:${MUTED}">${escapeHtml(COMPANY.legalName)} · ${escapeHtml(COMPANY.address)}</div>
            <div class="muted" style="color:${MUTED}"><a class="plain" href="${COMPANY.phoneHref}" style="color:${MUTED};text-decoration:none">${escapeHtml(COMPANY.phone)}</a> · <a class="plain" href="mailto:${escapeHtml(support)}" style="color:${MUTED};text-decoration:none">${escapeHtml(support)}</a></div>
            ${security ? `<div class="muted" style="margin-top:10px;color:${MUTED}">${escapeHtml(security)}</div>` : ''}
            <div class="muted" style="margin-top:10px;color:${MUTED}">${escapeHtml(chrome.reference)} <span style="font-family:Menlo,Consolas,monospace">${escapeHtml(refId)}</span></div>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;

  const textLines: string[] = [];
  if (o.greeting) textLines.push(o.greeting, '');
  textLines.push(o.heading, '');
  for (const p of o.paragraphs) textLines.push(p, '');
  if (o.summary && o.summary.length) {
    const w = Math.max(...o.summary.map((r) => r.label.length));
    for (const r of o.summary) textLines.push(`${r.label.padEnd(w)}  ${r.value}`);
    textLines.push('');
  }
  if (o.cta) textLines.push(`${o.cta.label}: ${o.cta.url}`, '');
  for (const p of o.after ?? []) textLines.push(p, '');
  textLines.push('—', chrome.sentBy, `${COMPANY.legalName} · ${COMPANY.address}`, `${COMPANY.phone} · ${support}`);
  if (security) textLines.push(security);
  textLines.push(`${chrome.reference} ${refId}`);
  const text = textLines.join('\n');

  return { subject: o.subject, heading: o.heading, html, text, htmlBytes: Buffer.byteLength(html, 'utf8') };
}

/** "Hi Maria," in the recipient's language. */
export function greetingFor(lang: EmailLang, firstName: string | null | undefined): string {
  const name = firstName?.trim();
  if (lang === 'es') return name ? `Hola ${name},` : 'Hola,';
  if (lang === 'tr') return name ? `Merhaba ${name},` : 'Merhaba,';
  return name ? `Hi ${name},` : 'Hello,';
}

/** Coerce a stored preference to a supported language, English when unknown. */
export function toEmailLang(v: string | null | undefined): EmailLang {
  return v === 'es' || v === 'tr' ? v : 'en';
}
