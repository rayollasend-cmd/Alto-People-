import { createHmac, timingSafeEqual } from 'node:crypto';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '@alto-people/shared';
import { env } from '../config/env.js';
import { COMPANY, escapeHtml, getEmailBrandName, manageNotificationsUrl, publicBaseUrl, type EmailLang } from './emailLayout.js';

/**
 * One-click unsubscribe tokens for broadcast/announcement email.
 *
 * RFC 8058 one-click unsubscribe means the mailbox provider POSTs the
 * List-Unsubscribe URL with NO session and NO user interaction, so — like
 * the iCal feed tokens in lib/calendarFeed.ts — the token in the URL IS
 * the authorization. The token binds the recipient email address:
 *
 *   token = base64url(email) + '.' + base64url(HMAC-SHA256(secret, 'unsub:' + email))
 *
 * Carrying the email inside the token (rather than HMAC-only) lets the
 * endpoint recover WHO is unsubscribing without a reverse lookup; the HMAC
 * half proves we minted it. The 'unsub:' domain prefix keeps these tokens
 * non-interchangeable with any other HMAC token minted from the same secret.
 *
 * Secret reuses CALENDAR_FEED_SECRET (falling back to JWT_SECRET) exactly
 * like the calendar feed — rotating that secret invalidates outstanding
 * unsubscribe links in old emails, which is acceptable: the settings page
 * remains the durable opt-out surface.
 */

function unsubscribeSecret(): string {
  return env.CALENDAR_FEED_SECRET ?? env.JWT_SECRET;
}

function sign(email: string): Buffer {
  return createHmac('sha256', unsubscribeSecret())
    .update(`unsub:${email}`, 'utf8')
    .digest();
}

/** Mint a token for `email`. The address is lowercased first so a token
 *  minted from a mixed-case source matches the stored lowercase form. */
export function mintUnsubscribeToken(email: string): string {
  const normalized = email.trim().toLowerCase();
  const payload = Buffer.from(normalized, 'utf8').toString('base64url');
  const sig = sign(normalized).toString('base64url');
  return `${payload}.${sig}`;
}

/**
 * Verify a token and return the bound (lowercased) email, or null when the
 * token is malformed or the signature doesn't match. Constant-time compare
 * with an explicit byte-length pre-check (timingSafeEqual throws on length
 * mismatch).
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  let email: string;
  let candidate: Buffer;
  try {
    email = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    candidate = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  if (!email || !email.includes('@')) return null;
  const normalized = email.toLowerCase();
  const expected = sign(normalized);
  if (candidate.length !== expected.length) return null;
  return timingSafeEqual(candidate, expected) ? normalized : null;
}

/* -------------------------------------------------------------------------- *
 *  ONE KIND OF EMAIL AT A TIME (owner, 2026-11-02)
 *
 *  Every notice email's "Stop emails like this" link and its List-Unsubscribe
 *  header mute the one settings bucket it belongs to — schedule changes, say
 *  — not everything. The token carries the bucket in the clear and signs it
 *  with the address:
 *
 *    token = base64url(email) + '.' + bucket + '.' + base64url(HMAC(secret, 'unsub-bucket:' + bucket + ':' + email))
 *
 *  A different domain prefix from the broadcast tokens above, so neither
 *  kind can stand in for the other. The two-part broadcast tokens already
 *  sitting in inboxes keep working and still mean the announcement bucket.
 *  Base64url never contains '.', so the three parts split cleanly.
 * -------------------------------------------------------------------------- */

const BUCKET_KEY = /^[a-z_]{2,40}$/;

function signBucket(email: string, bucket: string): Buffer {
  return createHmac('sha256', unsubscribeSecret())
    .update(`unsub-bucket:${bucket}:${email}`, 'utf8')
    .digest();
}

/** A token that mutes `bucket` for `email`. A pure signer: whether a bucket
 *  may be muted is decided where the link is offered (send()) and again
 *  where it is used (the route). */
export function mintBucketUnsubscribeToken(email: string, bucket: string): string {
  const normalized = email.trim().toLowerCase();
  const payload = Buffer.from(normalized, 'utf8').toString('base64url');
  return `${payload}.${bucket}.${signBucket(normalized, bucket).toString('base64url')}`;
}

export interface UnsubscribeTarget {
  /** The bound address, lowercased. */
  email: string;
  bucket: NotificationCategory;
  /** Required notices (security, emergencies, formal HR): never muted by a link. */
  mandatory: boolean;
}

/** Either kind of token → who and which bucket, or null when it is not one we minted. */
export function readUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const parts = token.split('.');
  if (parts.length === 2) {
    const email = verifyUnsubscribeToken(token);
    return email ? { email, bucket: 'broadcast', mandatory: false } : null;
  }
  if (parts.length !== 3) return null;
  const [payload, bucket, sig] = parts as [string, string, string];
  if (!payload || !sig || !BUCKET_KEY.test(bucket)) return null;
  const meta = NOTIFICATION_CATEGORIES.find((c) => c.key === bucket);
  if (!meta) return null;
  let email: string;
  let candidate: Buffer;
  try {
    email = Buffer.from(payload, 'base64url').toString('utf8');
    candidate = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (!email || !email.includes('@')) return null;
  const normalized = email.toLowerCase();
  const expected = signBucket(normalized, bucket);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
  return { email: normalized, bucket: meta.key, mandatory: meta.mandatory };
}

/** The one-click address a token lives at — the List-Unsubscribe header and the footer link both. */
export function unsubscribeUrl(token: string): string {
  return `${publicBaseUrl()}/api/communications/unsubscribe/${token}`;
}

/* ---- the page behind the footer link -------------------------------------- *
 *
 * A link in an email is opened by people AND fetched by link scanners and
 * mail previewers, so the GET only explains; the button POSTs. Standalone
 * HTML with inline CSS (no app bundle, no script): it must work in the
 * mail app's own browser on a cheap phone. The person's language comes from
 * their browser (the email layout's three languages).
 */

const PAGE_COPY: Record<EmailLang, {
  title: string;
  confirmHeading: string;
  confirmBody: (label: string) => string;
  keep: string;
  button: string;
  doneHeading: string;
  doneBody: (label: string) => string;
  alwaysOnHeading: string;
  alwaysOnBody: string;
  invalidHeading: string;
  invalidBody: string;
  manage: string;
}> = {
  en: {
    title: 'Email preferences',
    confirmHeading: 'Stop these emails?',
    confirmBody: (label) => `You'll stop getting emails about: ${label}.`,
    keep: 'They still show in the app, under the bell. Everything else keeps coming, and you can turn these back on in Settings any time.',
    button: 'Stop these emails',
    doneHeading: 'Done — these emails have stopped',
    doneBody: (label) => `No more emails about: ${label}. They still show in the app.`,
    alwaysOnHeading: 'These emails can’t be turned off',
    alwaysOnBody: 'Security, safety and required notices always reach you.',
    invalidHeading: 'This link doesn’t work',
    invalidBody: 'It may be from an old email. You can choose what reaches you in Settings.',
    manage: 'Manage notifications',
  },
  es: {
    title: 'Preferencias de correo',
    confirmHeading: '¿Dejar de recibir estos correos?',
    confirmBody: (label) => `Dejará de recibir correos sobre: ${label}.`,
    keep: 'Seguirán apareciendo en la aplicación, en la campana. Todo lo demás le sigue llegando y puede volver a activarlos en Configuración cuando quiera.',
    button: 'Dejar de recibir estos correos',
    doneHeading: 'Listo: ya no recibirá estos correos',
    doneBody: (label) => `No más correos sobre: ${label}. Seguirán apareciendo en la aplicación.`,
    alwaysOnHeading: 'Estos correos no se pueden desactivar',
    alwaysOnBody: 'Los avisos de seguridad de la cuenta, de seguridad en el trabajo y los obligatorios siempre le llegan.',
    invalidHeading: 'Este enlace no funciona',
    invalidBody: 'Puede ser de un correo antiguo. Puede elegir qué le llega en Configuración.',
    manage: 'Administrar notificaciones',
  },
  tr: {
    title: 'E-posta tercihleri',
    confirmHeading: 'Bu e-postalar durdurulsun mu?',
    confirmBody: (label) => `Şu konudaki e-postalar artık gelmeyecek: ${label}.`,
    keep: 'Uygulamada, zil simgesinin altında görünmeye devam ederler. Diğer her şey gelmeye devam eder; bunları istediğiniz zaman Ayarlar’dan yeniden açabilirsiniz.',
    button: 'Bu e-postaları durdur',
    doneHeading: 'Tamam — bu e-postalar durduruldu',
    doneBody: (label) => `Şu konuda artık e-posta yok: ${label}. Uygulamada görünmeye devam ederler.`,
    alwaysOnHeading: 'Bu e-postalar kapatılamaz',
    alwaysOnBody: 'Hesap güvenliği, iş güvenliği ve zorunlu bildirimler size her zaman ulaşır.',
    invalidHeading: 'Bu bağlantı çalışmıyor',
    invalidBody: 'Eski bir e-postadan olabilir. Size nelerin ulaşacağını Ayarlar’dan seçebilirsiniz.',
    manage: 'Bildirimleri yönet',
  },
};

export type UnsubscribePageState = 'confirm' | 'done' | 'always_on' | 'invalid';

/** The bucket's name as Settings shows it. */
function bucketLabel(bucket: string | null): string {
  return NOTIFICATION_CATEGORIES.find((c) => c.key === bucket)?.label ?? '';
}

export function unsubscribePageHtml(o: { state: UnsubscribePageState; lang: EmailLang; bucket: string | null }): string {
  const c = PAGE_COPY[o.lang];
  const brand = getEmailBrandName();
  const label = bucketLabel(o.bucket);
  const manage = `<p class="manage"><a href="${escapeHtml(manageNotificationsUrl())}">${escapeHtml(c.manage)}</a></p>`;
  let body: string;
  if (o.state === 'confirm') {
    // Posting to the page's own address with ?via=page: the answer is this
    // page's done state, not the bare JSON a mailbox provider gets.
    body = `<h1>${escapeHtml(c.confirmHeading)}</h1>
<p>${escapeHtml(c.confirmBody(label))}</p>
<p class="muted">${escapeHtml(c.keep)}</p>
<form method="post" action="?via=page"><button type="submit">${escapeHtml(c.button)}</button></form>
${manage}`;
  } else if (o.state === 'done') {
    body = `<h1>${escapeHtml(c.doneHeading)}</h1>
<p>${escapeHtml(c.doneBody(label))}</p>
${manage}`;
  } else if (o.state === 'always_on') {
    body = `<h1>${escapeHtml(c.alwaysOnHeading)}</h1>
<p>${escapeHtml(c.alwaysOnBody)}</p>
${manage}`;
  } else {
    body = `<h1>${escapeHtml(c.invalidHeading)}</h1>
<p>${escapeHtml(c.invalidBody)}</p>
${manage}`;
  }
  return `<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(`${c.title} · ${brand}`)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:#F3F4F6;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{width:100%;max-width:440px;background:#FFFFFF;border-radius:12px;border-top:4px solid #C9A84C;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.brand{margin:0 0 20px;font-size:14px;font-weight:700;letter-spacing:.02em;color:#0B1B3A}
h1{margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600}
p{margin:0 0 14px;font-size:16px;line-height:24px}
.muted{color:#6B7280;font-size:14px;line-height:21px}
button{display:block;width:100%;margin:8px 0 16px;padding:14px 20px;border:0;border-radius:8px;background:#0B1B3A;color:#FFFFFF;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
.manage{margin:0;font-size:14px}
a{color:#0B1B3A}
.legal{margin:20px 0 0;color:#6B7280;font-size:12px;line-height:18px}
@media (prefers-color-scheme:dark){
body{background:#0F172A;color:#E2E8F0}
main{background:#1E293B}
.brand,a{color:#E2E8F0}
.muted,.legal{color:#94A3B8}
button{background:#FFFFFF;color:#0B1B3A}
}
</style>
</head>
<body>
<main>
<p class="brand">${escapeHtml(brand)}</p>
${body}
<p class="legal">${escapeHtml(COMPANY.legalName)}</p>
</main>
</body>
</html>`;
}

/** The page's language from the browser's Accept-Language (en, es or tr). */
export function pageLang(acceptLanguage: string | undefined): EmailLang {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if (tag === 'es' || tag === 'tr' || tag === 'en') return tag;
  }
  return 'en';
}
