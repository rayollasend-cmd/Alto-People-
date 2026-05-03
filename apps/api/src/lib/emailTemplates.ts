/**
 * Centralized email templates for every system-triggered notification.
 *
 * Each builder returns `{ subject, text, html }`:
 *   - subject  : prefixed `[Action Required]` / `[For Your Review]` / etc.
 *                so recipients can triage in their inbox.
 *   - text     : plain-text body. Mandatory — Resend uses this as the
 *                deliverability fallback and spam classifiers read it.
 *   - html     : branded HTML body wrapped in the standard layout (header
 *                bar, monospaced data block, footer with signature +
 *                confidentiality + reply-to disclaimer).
 *
 * Voice: third person for system events; second person only when addressing
 * the recipient directly. Every template ends with the standard Alto HR
 * signature block, optionally swapped for an HR actor's name on
 * personally-actioned messages (rejections, discipline).
 *
 * To add a new template:
 *   1. Define an `interface XxxOpts { ... }` for the substitution fields.
 *   2. Export `xxxTemplate(opts: XxxOpts): EmailTemplate`.
 *   3. Compose `text` from a TS template literal; build `html` via
 *      `wrapHtml({ heading, intro, dataBlock, body, cta, signatory })`.
 *   4. Reference IDs are auto-generated via `formatRef()` — no callsite
 *      coordination needed.
 */
import { env } from '../config/env.js';

/* ============================================================== */
/* Types                                                          */
/* ============================================================== */

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

/**
 * Identifies who the email is "from" in the human sense — drives the
 * signature block. System notifications use `system`; HR actions use
 * `actor` so the disciplined associate sees who issued the action.
 */
export type Signatory =
  | { kind: 'system' }
  | { kind: 'actor'; name: string; role: string };

interface DataRow {
  label: string;
  value: string;
}

interface WrapHtmlOpts {
  /** Big heading at the top of the email body. Often mirrors the subject. */
  heading: string;
  /** One-paragraph intro that sets context. */
  intro: string;
  /** Optional structured key/value rows shown in a styled table. */
  dataBlock?: DataRow[];
  /**
   * Optional follow-on paragraphs (already escaped). Use for compliance
   * language, instructions, or expectations after the data block.
   */
  body?: string[];
  /** Optional call-to-action. Renders as a styled button + raw URL fallback. */
  cta?: { label: string; url: string };
  signatory: Signatory;
  refId: string;
}

/* ============================================================== */
/* Constants                                                      */
/* ============================================================== */

const BRAND_COLOR = '#0F2A44'; // deep navy — pick a brand color in design
const BRAND_ACCENT = '#C9A24C'; // warm gold — for the CTA button accent
const TEXT_COLOR = '#1A1A1A';
const MUTED_COLOR = '#6B6B6B';
const BORDER_COLOR = '#E5E7EB';
const COMPANY_NAME = 'Alto HR';
const COMPANY_DEPT = 'Workforce Management Operations';
const COMPANY_EMAIL = 'hr@altohr.com';
const COMPANY_WEB = 'altohr.com';
const REPLY_TO_NOTE = env.RESEND_REPLY_TO
  ? `Replies to this address are not monitored. For assistance, contact ${env.RESEND_REPLY_TO} or your HR administrator.`
  : 'Replies to this address are not monitored. For assistance, contact your HR administrator.';

/* ============================================================== */
/* Reference ID                                                   */
/* ============================================================== */

/**
 * Short, human-readable reference shown at the bottom of every email.
 * Format: ALT-{base36 timestamp}-{4-char random}. Recipients can quote
 * this when contacting support. Not stored anywhere — purely informational.
 */
export function formatRef(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `ALT-${ts}-${rand}`;
}

/* ============================================================== */
/* Signature                                                      */
/* ============================================================== */

function signatureText(sig: Signatory, refId: string): string {
  const top =
    sig.kind === 'actor'
      ? `${sig.name}\n${sig.role}, ${COMPANY_NAME}`
      : `${COMPANY_NAME}\n${COMPANY_DEPT}`;
  return [
    '',
    '———',
    top,
    `${COMPANY_EMAIL}  ·  ${COMPANY_WEB}`,
    '',
    'CONFIDENTIAL — This message and any attachments are intended solely for',
    'the addressee and may contain confidential, proprietary, or legally',
    'privileged information. If you received this in error, please delete it',
    'and notify the sender immediately.',
    '',
    REPLY_TO_NOTE,
    '',
    `Reference: ${refId}`,
  ].join('\n');
}

function signatureHtml(sig: Signatory, refId: string): string {
  const top =
    sig.kind === 'actor'
      ? `<div style="font-weight:600;color:${TEXT_COLOR}">${escapeHtml(sig.name)}</div>
         <div style="color:${MUTED_COLOR};font-size:13px">${escapeHtml(sig.role)}, ${COMPANY_NAME}</div>`
      : `<div style="font-weight:600;color:${TEXT_COLOR}">${COMPANY_NAME}</div>
         <div style="color:${MUTED_COLOR};font-size:13px">${COMPANY_DEPT}</div>`;
  return `
    <div style="margin-top:32px;padding-top:24px;border-top:1px solid ${BORDER_COLOR}">
      ${top}
      <div style="margin-top:6px;color:${MUTED_COLOR};font-size:13px">
        <a href="mailto:${COMPANY_EMAIL}" style="color:${MUTED_COLOR};text-decoration:none">${COMPANY_EMAIL}</a>
        &nbsp;·&nbsp;
        <a href="https://${COMPANY_WEB}" style="color:${MUTED_COLOR};text-decoration:none">${COMPANY_WEB}</a>
      </div>
    </div>
    <div style="margin-top:24px;padding:16px;background:#FAFAF7;border-radius:6px;color:${MUTED_COLOR};font-size:11px;line-height:1.5">
      <strong style="color:${TEXT_COLOR}">CONFIDENTIAL</strong> — This message and any attachments are intended
      solely for the addressee and may contain confidential, proprietary, or legally
      privileged information. If you received this in error, please delete it and
      notify the sender immediately.
      <br><br>
      ${REPLY_TO_NOTE}
      <br><br>
      <span style="font-family:Menlo,Consolas,monospace">Reference: ${refId}</span>
    </div>`;
}

/* ============================================================== */
/* HTML wrapper                                                   */
/* ============================================================== */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dataBlockHtml(rows: DataRow[]): string {
  const trs = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:8px 16px 8px 0;color:${MUTED_COLOR};font-size:13px;text-transform:uppercase;letter-spacing:0.04em;vertical-align:top;white-space:nowrap">${escapeHtml(r.label)}</td>
        <td style="padding:8px 0;color:${TEXT_COLOR};font-size:14px;vertical-align:top">${escapeHtml(r.value)}</td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:24px 0;border-top:1px solid ${BORDER_COLOR};border-bottom:1px solid ${BORDER_COLOR}">
      ${trs}
    </table>`;
}

function ctaHtml(cta: { label: string; url: string }): string {
  return `
    <div style="margin:32px 0;text-align:center">
      <a href="${escapeHtml(cta.url)}"
         style="display:inline-block;padding:14px 28px;background:${BRAND_COLOR};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;border-radius:6px;border-bottom:3px solid ${BRAND_ACCENT}">
        ${escapeHtml(cta.label)}
      </a>
      <div style="margin-top:12px;color:${MUTED_COLOR};font-size:12px;word-break:break-all">
        Or paste this link into your browser:<br>
        <a href="${escapeHtml(cta.url)}" style="color:${MUTED_COLOR}">${escapeHtml(cta.url)}</a>
      </div>
    </div>`;
}

function wrapHtml(opts: WrapHtmlOpts): string {
  const bodyParas =
    opts.body && opts.body.length > 0
      ? opts.body.map((p) => `<p style="margin:16px 0;color:${TEXT_COLOR};font-size:15px;line-height:1.6">${p}</p>`).join('')
      : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(opts.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT_COLOR}">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#F4F4F0">
    <tr>
      <td align="center" style="padding:32px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
          <tr>
            <td style="background:${BRAND_COLOR};padding:20px 32px">
              <div style="color:#FFFFFF;font-weight:700;font-size:18px;letter-spacing:0.04em">ALTO HR</div>
              <div style="color:${BRAND_ACCENT};font-size:11px;text-transform:uppercase;letter-spacing:0.18em;margin-top:2px">Workforce Management</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;color:${TEXT_COLOR};line-height:1.3">${escapeHtml(opts.heading)}</h1>
              <p style="margin:0 0 16px;color:${TEXT_COLOR};font-size:15px;line-height:1.6">${opts.intro}</p>
              ${opts.dataBlock ? dataBlockHtml(opts.dataBlock) : ''}
              ${bodyParas}
              ${opts.cta ? ctaHtml(opts.cta) : ''}
              ${signatureHtml(opts.signatory, opts.refId)}
            </td>
          </tr>
        </table>
        <div style="max-width:600px;margin:16px auto 0;color:${MUTED_COLOR};font-size:11px;text-align:center">
          © ${new Date().getFullYear()} Alto HR. All rights reserved.
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/* ============================================================== */
/* Plain-text helpers                                             */
/* ============================================================== */

function dataBlockText(rows: DataRow[]): string {
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => `  ${r.label.padEnd(labelWidth)}   ${r.value}`).join('\n');
}

function composeText(parts: {
  greeting?: string;
  intro: string;
  dataBlock?: DataRow[];
  body?: string[];
  cta?: { label: string; url: string };
  signatory: Signatory;
  refId: string;
}): string {
  const lines: string[] = [];
  if (parts.greeting) lines.push(parts.greeting, '');
  lines.push(parts.intro);
  if (parts.dataBlock && parts.dataBlock.length) {
    lines.push('', dataBlockText(parts.dataBlock));
  }
  if (parts.body && parts.body.length) {
    for (const p of parts.body) lines.push('', p);
  }
  if (parts.cta) {
    lines.push('', `${parts.cta.label}:`, parts.cta.url);
  }
  lines.push(signatureText(parts.signatory, parts.refId));
  return lines.join('\n');
}

/* ============================================================== */
/* TEMPLATES                                                      */
/* ============================================================== */

/* ---------------- ONBOARDING --------------------------------- */

export interface InviteOpts {
  firstName: string;
  clientName: string;
  position?: string | null;
  hireDate?: string | null;
  magicLink: string;
  linkExpiresAt: string;
}
export function inviteTemplate(opts: InviteOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Required] Complete your onboarding with ${opts.clientName}`;
  const heading = `Welcome to ${opts.clientName}`;
  const intro = `You have been invited to complete pre-employment onboarding for ${opts.clientName}. The process takes approximately 15 minutes and must be finished before your scheduled start date.`;
  const dataBlock: DataRow[] = [];
  if (opts.position) dataBlock.push({ label: 'Position', value: opts.position });
  if (opts.hireDate) dataBlock.push({ label: 'Start date', value: opts.hireDate });
  dataBlock.push({ label: 'Estimated time', value: '15 minutes' });
  dataBlock.push({ label: 'Link expires', value: opts.linkExpiresAt });
  const text = composeText({
    greeting: `${opts.firstName},`,
    intro,
    dataBlock,
    cta: { label: 'Begin onboarding', url: opts.magicLink },
    body: ['This link is unique to you. Do not forward it. If it expires, contact your hiring representative for a new invitation.'],
    signatory: { kind: 'system' },
    refId,
  });
  const html = wrapHtml({
    heading,
    intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
    dataBlock,
    body: [
      `This link is unique to you. <strong>Do not forward it.</strong> If it expires, contact your hiring representative for a new invitation.`,
    ],
    cta: { label: 'Begin onboarding', url: opts.magicLink },
    signatory: { kind: 'system' },
    refId,
  });
  return { subject, text, html };
}

export interface ApplicationApprovedOpts {
  firstName: string;
  clientName: string;
  position?: string | null;
  hireDate: string;
  managerName?: string | null;
  location?: string | null;
  appUrl: string;
}
export function applicationApprovedTemplate(opts: ApplicationApprovedOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Confirmation] Your offer with ${opts.clientName} has been finalized`;
  const heading = `You are cleared to start at ${opts.clientName}`;
  const intro = `Your onboarding has been reviewed and approved. You are formally cleared to begin work at ${opts.clientName}.`;
  const dataBlock: DataRow[] = [];
  if (opts.position) dataBlock.push({ label: 'Position', value: opts.position });
  dataBlock.push({ label: 'Start date', value: opts.hireDate });
  if (opts.managerName) dataBlock.push({ label: 'Reporting to', value: opts.managerName });
  if (opts.location) dataBlock.push({ label: 'Work location', value: opts.location });
  const followUp = 'Direct any questions to your assigned manager or the HR contact for your site.';
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      cta: { label: 'Open your associate dashboard', url: opts.appUrl },
      body: [followUp],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      cta: { label: 'Open dashboard', url: opts.appUrl },
      body: [escapeHtml(followUp)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface ApplicationRejectedOpts {
  firstName: string;
  clientName: string;
  rejectionReason: string;
  decisionDate: string;
}
export function applicationRejectedTemplate(opts: ApplicationRejectedOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Update] Decision on your application with ${opts.clientName}`;
  const heading = `Update on your application`;
  const intro = `Thank you for your interest in joining ${opts.clientName}. After review, we will not be moving forward with your application at this time.`;
  const dataBlock: DataRow[] = [
    { label: 'Decision', value: 'Not advancing' },
    { label: 'Date', value: opts.decisionDate },
    { label: 'Reason on file', value: opts.rejectionReason },
  ];
  const para = `This decision does not preclude you from being considered for future opportunities. If you would like clarification or believe information in your application was misinterpreted, you may submit a written response to HR within 10 business days of this notice.`;
  const close = `We appreciate the time you invested in the process and wish you well.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      body: [para, close],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      body: [escapeHtml(para), escapeHtml(close)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface OnboardingCompleteOpts {
  associateName: string;
  clientName: string;
  position?: string | null;
  submittedAt: string;
  applicationUrl: string;
}
export function onboardingCompleteTemplate(opts: OnboardingCompleteOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[For Your Review] Onboarding ready — ${opts.associateName} (${opts.clientName})`;
  const heading = `Onboarding complete — ready for review`;
  const intro = `The following application has completed all onboarding requirements and is ready for final review.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Client', value: opts.clientName },
  ];
  if (opts.position) dataBlock.push({ label: 'Position', value: opts.position });
  dataBlock.push({ label: 'Submitted', value: opts.submittedAt });
  const tail = `This notification is sent once per application. Subsequent task updates will not generate additional notices.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      cta: { label: 'Open the application', url: opts.applicationUrl },
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      cta: { label: 'Open application', url: opts.applicationUrl },
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface I9Section2Opts {
  associateName: string;
  clientName: string;
  hireDate?: string | null;
  section2DueDate?: string | null;
  i9Url: string;
}
export function i9Section2Template(opts: I9Section2Opts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Required — Compliance] I-9 Section 2 due for ${opts.associateName}`;
  const heading = `I-9 Section 2 verification required`;
  const intro = `${opts.associateName} has signed I-9 Section 1.`;
  const compliance = `USCIS regulations require Section 2 to be completed within three (3) business days of the associate's first day of work for pay. Late completion is a recordable compliance violation.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Client', value: opts.clientName },
  ];
  if (opts.hireDate) dataBlock.push({ label: 'Start date', value: opts.hireDate });
  if (opts.section2DueDate) dataBlock.push({ label: 'Section 2 due', value: opts.section2DueDate });
  return {
    subject,
    text: composeText({
      intro: `${intro}\n\n${compliance}`,
      dataBlock,
      cta: { label: 'Open the I-9 task', url: opts.i9Url },
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      body: [escapeHtml(compliance)],
      dataBlock,
      cta: { label: 'Open I-9 task', url: opts.i9Url },
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- DOCUMENTS ---------------------------------- */

export interface DocumentUploadedOpts {
  associateName: string;
  documentKind: string;
  filename: string;
  uploadedAt: string;
  documentsUrl: string;
}
export function documentUploadedTemplate(opts: DocumentUploadedOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[For Your Review] Document uploaded — ${opts.associateName}`;
  const heading = `Document review needed`;
  const intro = `A new document has been submitted and requires verification.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Document type', value: opts.documentKind },
    { label: 'File', value: opts.filename },
    { label: 'Submitted', value: opts.uploadedAt },
  ];
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      cta: { label: 'Verify or reject the document', url: opts.documentsUrl },
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      cta: { label: 'Review document', url: opts.documentsUrl },
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface DocumentRejectedAssociateOpts {
  firstName: string;
  documentKind: string;
  filename: string;
  rejectionReason: string;
  reviewerName: string;
  documentsUrl: string;
}
export function documentRejectedAssociateTemplate(
  opts: DocumentRejectedAssociateOpts,
): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Required] Re-upload requested for your ${opts.documentKind}`;
  const heading = `Document re-upload requested`;
  const intro = `A document you submitted has been returned for re-upload.`;
  const dataBlock: DataRow[] = [
    { label: 'Document type', value: opts.documentKind },
    { label: 'File', value: opts.filename },
    { label: 'Status', value: 'Not accepted' },
    { label: 'Reason', value: opts.rejectionReason },
    { label: 'Reviewed by', value: opts.reviewerName },
  ];
  const ask = `Please submit a replacement at your earliest convenience to remain on track for your scheduled start date.`;
  const help = `If the reason is unclear or you require assistance preparing the replacement, contact your hiring representative.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      body: [ask, help],
      cta: { label: 'Open Identity Documents', url: opts.documentsUrl },
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      body: [escapeHtml(ask), escapeHtml(help)],
      cta: { label: 'Open Identity Documents', url: opts.documentsUrl },
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface DocumentRejectedManagerOpts {
  associateName: string;
  documentKind: string;
  rejectionReason: string;
  reviewerName: string;
}
export function documentRejectedManagerTemplate(
  opts: DocumentRejectedManagerOpts,
): EmailTemplate {
  const refId = formatRef();
  const subject = `[Notification] Document re-upload pending — ${opts.associateName}`;
  const heading = `Document re-upload pending`;
  const intro = `A document submitted by your direct report was returned for re-upload. The associate has been notified and asked to provide a replacement.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Document type', value: opts.documentKind },
    { label: 'Reason', value: opts.rejectionReason },
    { label: 'Reviewed by', value: opts.reviewerName },
  ];
  const tail = `No action is required from you. This notice is informational. If the re-upload is not received within 5 business days, HR will follow up.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- AUTH --------------------------------------- */

export interface PasswordResetOpts {
  firstName: string;
  email: string;
  requestedAt: string;
  resetLink: string;
}
export function passwordResetTemplate(opts: PasswordResetOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Security] Alto HR password reset requested`;
  const heading = `Password reset requested`;
  const intro = `A password reset was requested for your Alto HR account. To proceed, use the secure link below.`;
  const dataBlock: DataRow[] = [
    { label: 'Account', value: opts.email },
    { label: 'Requested at', value: opts.requestedAt },
    { label: 'Link expires', value: '60 minutes from request time' },
  ];
  const ifNotYou = `If you did not initiate this request, you may safely disregard this message. No change will be made unless the link is used.`;
  const security = `For your protection, Alto HR personnel will never request your password, multi-factor codes, or this reset link by phone, email, or chat. If you suspect account compromise, contact HR immediately.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      cta: { label: 'Reset password', url: opts.resetLink },
      body: [ifNotYou, security],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      cta: { label: 'Reset password', url: opts.resetLink },
      body: [escapeHtml(ifNotYou), escapeHtml(security)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- SCHEDULING --------------------------------- */

export interface ShiftSwapPeerOpts {
  firstName: string;
  requesterName: string;
  position: string;
  clientName: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
  location?: string | null;
  note?: string | null;
  swapUrl: string;
}
export function shiftSwapPeerTemplate(opts: ShiftSwapPeerOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Requested] Shift swap from ${opts.requesterName}`;
  const heading = `Shift swap request`;
  const intro = `${opts.requesterName} has requested that you cover the following shift.`;
  const dataBlock: DataRow[] = [
    { label: 'Position', value: opts.position },
    { label: 'Client', value: opts.clientName },
    { label: 'Date', value: opts.shiftDate },
    { label: 'Time', value: `${opts.startsAt} — ${opts.endsAt}` },
  ];
  if (opts.location) dataBlock.push({ label: 'Location', value: opts.location });
  if (opts.note) dataBlock.push({ label: 'Note', value: opts.note });
  const tail = `If you accept, the swap is forwarded to the assigned manager for final approval before it takes effect. Either party may withdraw at any time prior to manager approval.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      cta: { label: 'Review and respond', url: opts.swapUrl },
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      cta: { label: 'Review request', url: opts.swapUrl },
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface ShiftSwapManagerOpts {
  requesterName: string;
  counterpartyName: string;
  position: string;
  clientName: string;
  shiftDate: string;
  startsAt: string;
  endsAt: string;
}
export function shiftSwapManagerTemplate(opts: ShiftSwapManagerOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[FYI] Shift swap initiated — ${opts.requesterName} → ${opts.counterpartyName}`;
  const heading = `Shift swap initiated`;
  const intro = `A shift swap is in flight between two of your associates. No action is required from you until the peer responds.`;
  const dataBlock: DataRow[] = [
    { label: 'Original assignee', value: opts.requesterName },
    { label: 'Proposed assignee', value: opts.counterpartyName },
    { label: 'Position', value: opts.position },
    { label: 'Client', value: opts.clientName },
    { label: 'Shift', value: `${opts.shiftDate}, ${opts.startsAt} — ${opts.endsAt}` },
    { label: 'Status', value: 'Awaiting peer response' },
  ];
  const tail = `You will receive a separate notification when the peer accepts and your approval is required.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- TIME OFF ----------------------------------- */

export interface TimeOffRequestOpts {
  associateName: string;
  category: string;
  hours: number;
  dateRange: string;
  balanceHours?: number | null;
  reason?: string | null;
  submittedAt: string;
  timeOffUrl: string;
}
export function timeOffRequestTemplate(opts: TimeOffRequestOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Required] Time-off request — ${opts.associateName} (${opts.dateRange})`;
  const heading = `Time-off request awaiting your decision`;
  const intro = `A direct report has submitted a time-off request for your review.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Type', value: opts.category },
    { label: 'Hours', value: String(opts.hours) },
    { label: 'Date range', value: opts.dateRange },
  ];
  if (opts.balanceHours !== null && opts.balanceHours !== undefined) {
    dataBlock.push({ label: 'Available balance', value: `${opts.balanceHours} hours` });
  }
  if (opts.reason) dataBlock.push({ label: 'Reason', value: opts.reason });
  dataBlock.push({ label: 'Submitted', value: opts.submittedAt });
  const policy = `Per policy, requests not actioned within three (3) business days are escalated to HR for disposition. Maintain timely review to retain discretion over coverage on your team.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      cta: { label: 'Approve or deny', url: opts.timeOffUrl },
      body: [policy],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      cta: { label: 'Review request', url: opts.timeOffUrl },
      body: [escapeHtml(policy)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- PERFORMANCE -------------------------------- */

export interface DisciplineAssociateOpts {
  firstName: string;
  kindLabel: string;
  effectiveDate: string;
  incidentDate: string;
  suspensionDays?: number | null;
  description: string;
  expectedAction?: string | null;
  actor: { name: string; role: string };
  disciplineUrl: string;
}
export function disciplineAssociateTemplate(opts: DisciplineAssociateOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Important — HR Notice] Disciplinary action issued: ${opts.kindLabel}`;
  const heading = `Formal disciplinary action — ${opts.kindLabel}`;
  const intro = `Please be advised that a formal disciplinary action has been entered on your employment record.`;
  const dataBlock: DataRow[] = [
    { label: 'Action type', value: opts.kindLabel },
    { label: 'Effective date', value: opts.effectiveDate },
    { label: 'Incident date', value: opts.incidentDate },
  ];
  if (opts.suspensionDays) {
    dataBlock.push({ label: 'Suspension period', value: `${opts.suspensionDays} day(s)` });
  }
  dataBlock.push({ label: 'Issued by', value: `${opts.actor.name}, ${opts.actor.role}` });
  const summary = `Summary of incident: ${opts.description}`;
  const expectation = opts.expectedAction ? `Expected corrective action: ${opts.expectedAction}` : null;
  const ack = `You are required to acknowledge receipt of this action within five (5) business days. Acknowledgment confirms that you have reviewed the notice; it does not constitute agreement with its contents. If you disagree with any portion of this action, you may submit a written response that will be retained alongside the original record.`;
  const consequence = `Failure to acknowledge within the prescribed window may itself become the subject of further action. If you have questions about your rights in this process, contact HR or your designated representative.`;
  const body = [summary, ...(expectation ? [expectation] : []), ack, consequence];
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      body,
      cta: { label: 'Acknowledge and review', url: opts.disciplineUrl },
      signatory: { kind: 'actor', name: opts.actor.name, role: opts.actor.role },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      body: body.map(escapeHtml),
      cta: { label: 'Acknowledge and review', url: opts.disciplineUrl },
      signatory: { kind: 'actor', name: opts.actor.name, role: opts.actor.role },
      refId,
    }),
  };
}

export interface DisciplineManagerOpts {
  associateName: string;
  kindLabel: string;
  effectiveDate: string;
  suspensionDays?: number | null;
  actor: { name: string; role: string };
}
export function disciplineManagerTemplate(opts: DisciplineManagerOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Notification] Disciplinary action filed — ${opts.associateName}`;
  const heading = `Disciplinary action filed on direct report`;
  const intro = `A formal disciplinary action has been entered on the record of one of your direct reports.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Action type', value: opts.kindLabel },
    { label: 'Effective date', value: opts.effectiveDate },
  ];
  if (opts.suspensionDays) {
    dataBlock.push({ label: 'Suspension period', value: `${opts.suspensionDays} day(s)` });
  }
  dataBlock.push({ label: 'Issued by', value: `${opts.actor.name}, ${opts.actor.role}` });
  const tail = `The associate has been notified and asked to acknowledge receipt within five (5) business days. Coordinate any follow-up coaching or coverage adjustments with HR as appropriate.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

export interface ProbationAssociateOpts {
  firstName: string;
  startDate: string;
  endDate: string;
  durationDays: number;
  actor: { name: string; role: string };
}
export function probationAssociateTemplate(opts: ProbationAssociateOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Important — HR Notice] Probationary period commenced`;
  const heading = `Probationary period commenced`;
  const intro = `This is to confirm that you have been placed on a formal probationary period.`;
  const dataBlock: DataRow[] = [
    { label: 'Period', value: `${opts.startDate} — ${opts.endDate}` },
    { label: 'Duration', value: `${opts.durationDays} days` },
    { label: 'Established by', value: `${opts.actor.name}, ${opts.actor.role}` },
  ];
  const expectations = `During this period, your manager will conduct enhanced performance reviews and document progress against the expectations they will share with you in a one-on-one conversation. At the conclusion of the period, the probation will be resolved as one of: Passed (probation closed, no further action), Extended (additional review window opened), or Failed (separation proceedings may be initiated).`;
  const rights = `You are entitled to clear, written expectations for the duration of this period. If your manager has not scheduled a kickoff conversation with you within five (5) business days, please escalate to HR.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      body: [expectations, rights],
      signatory: { kind: 'actor', name: opts.actor.name, role: opts.actor.role },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      body: [escapeHtml(expectations), escapeHtml(rights)],
      signatory: { kind: 'actor', name: opts.actor.name, role: opts.actor.role },
      refId,
    }),
  };
}

export interface ProbationManagerOpts {
  associateName: string;
  startDate: string;
  endDate: string;
  actor: { name: string; role: string };
}
export function probationManagerTemplate(opts: ProbationManagerOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Action Required] Probation kickoff for ${opts.associateName}`;
  const heading = `Probation kickoff required`;
  const intro = `A probationary period has been opened on one of your direct reports.`;
  const dataBlock: DataRow[] = [
    { label: 'Associate', value: opts.associateName },
    { label: 'Period', value: `${opts.startDate} — ${opts.endDate}` },
    { label: 'Established by', value: `${opts.actor.name}, ${opts.actor.role}` },
  ];
  const ask =
    'Please complete the following within five (5) business days: ' +
    '(1) schedule a kickoff conversation with the associate; ' +
    '(2) document the specific performance expectations to be met; ' +
    '(3) set check-in cadence (recommended: weekly).';
  const tail = `The probation status will remain visible on the associate's profile until you mark it Passed, Extended, or Failed. HR will follow up if no resolution is recorded by the end date.`;
  return {
    subject,
    text: composeText({
      intro,
      dataBlock,
      body: [ask, tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: escapeHtml(intro),
      dataBlock,
      body: [escapeHtml(ask), escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}

/* ---------------- SYSTEM ------------------------------------- */

export interface OnboardingReminderOpts {
  firstName: string;
  clientName: string;
  percentComplete: number;
  hireDate?: string | null;
  daysRemaining?: number | null;
  magicLink: string;
}
export function onboardingReminderTemplate(opts: OnboardingReminderOpts): EmailTemplate {
  const refId = formatRef();
  const subject = `[Reminder] Onboarding completion required — ${opts.clientName}`;
  const heading = `Onboarding still incomplete`;
  const intro = `This is an automated reminder that your onboarding for ${opts.clientName} remains incomplete.`;
  const dataBlock: DataRow[] = [
    { label: 'Status', value: `${opts.percentComplete}% complete` },
  ];
  if (opts.hireDate) dataBlock.push({ label: 'Start date', value: opts.hireDate });
  if (opts.daysRemaining !== null && opts.daysRemaining !== undefined) {
    dataBlock.push({ label: 'Days until start', value: String(opts.daysRemaining) });
  }
  const tail = `If your invitation link has expired or you require assistance, contact your hiring representative for a new invitation.`;
  return {
    subject,
    text: composeText({
      greeting: `${opts.firstName},`,
      intro,
      dataBlock,
      cta: { label: 'Complete remaining items', url: opts.magicLink },
      body: [tail],
      signatory: { kind: 'system' },
      refId,
    }),
    html: wrapHtml({
      heading,
      intro: `${escapeHtml(opts.firstName)}, ${escapeHtml(intro)}`,
      dataBlock,
      cta: { label: 'Complete remaining items', url: opts.magicLink },
      body: [escapeHtml(tail)],
      signatory: { kind: 'system' },
      refId,
    }),
  };
}
