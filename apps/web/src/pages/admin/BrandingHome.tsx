import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ASSISTANT_NAME_PROMPT,
  ASSISTANT_PLATFORM_NAME,
  HEX_COLOR_REGEX,
  ORG_LOGO_ALLOWED_TYPES,
  ORG_LOGO_MAX_BYTES,
  PRODUCT_NAME,
  type OrgBranding,
} from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { errorText } from '@/lib/errorText';
import { fmtDateTime } from '@/lib/format';
import { DEFAULT_BRAND_PRIMARY } from '@/lib/brandDefaults';
import { deleteOrgLogo, getOrgBranding, patchOrgBranding, uploadOrgLogo } from '@/lib/brandingApi';
import { ORG_SETTINGS_KEY } from '@/lib/orgSettingsKey';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSection } from '@/components/templates';
import { SettingsSaveBar } from '@/pages/settings/SettingsSaveBar';

const EMAIL = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

interface Identity {
  orgName: string;
  assistantName: string;
  senderName: string;
  supportEmail: string;
  primaryColor: string;
}

function identityOf(b: OrgBranding): Identity {
  return {
    orgName: b.orgName,
    assistantName: b.assistantName ?? ASSISTANT_PLATFORM_NAME,
    senderName: b.senderName ?? '',
    supportEmail: b.supportEmail ?? '',
    primaryColor: b.primaryColor ?? '',
  };
}

/**
 * Branding (F500 G4): how the organization looks and signs its email — the
 * name, the assistant's name, the sender, the support address, the colour
 * and the logo. Nothing else.
 *
 * Settings that used to be misfiled here have their own homes, and the
 * Settings search finds them by name: two-step sign-in on Sign-in; the
 * finance mailbox, unverified-bank policy, remit-to and cash floor on
 * Finance; the second-person rules on Approval rules; the workweek and the
 * company time zone on Organization.
 */
export function BrandingHome() {
  const { can, refreshUser } = useAuth();
  const canManage = can('manage:org');
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => getOrgBranding() });
  const branding = q.data ?? null;
  const saved = useMemo(() => (branding ? identityOf(branding) : null), [branding]);
  const [draft, setDraft] = useState<Identity | null>(null);
  useEffect(() => setDraft(saved), [saved]);
  const [touched, setTouched] = useState({ supportEmail: false, primaryColor: false });
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoBust, setLogoBust] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Identity>(k: K, v: Identity[K]) => setDraft((d) => d && { ...d, [k]: v });

  const colorValid = !draft || draft.primaryColor === '' || HEX_COLOR_REGEX.test(draft.primaryColor);
  const emailValid = !draft || draft.supportEmail === '' || EMAIL.test(draft.supportEmail);
  const nameValid = !draft || draft.orgName.trim() !== '';
  const dirty = saved && draft ? (Object.keys(saved) as Array<keyof Identity>).filter((k) => saved[k].trim() !== draft[k].trim()).length : 0;

  const onSave = async () => {
    if (!draft) return;
    if (!nameValid) return void toast.error("Enter your organization's name.");
    if (!colorValid) return void toast.error('The colour is a #RRGGBB hex value.');
    if (!emailValid) return void toast.error('The support email is a bare address like info@example.com.');
    setSaving(true);
    try {
      const updated = await patchOrgBranding({
        orgName: draft.orgName.trim(),
        assistantName: draft.assistantName.trim() || ASSISTANT_PLATFORM_NAME,
        senderName: draft.senderName.trim() || null,
        supportEmail: draft.supportEmail.trim() || null,
        primaryColor: draft.primaryColor.trim() || null,
      });
      qc.setQueryData(ORG_SETTINGS_KEY, updated);
      toast.success('Branding saved.');
      // The assistant's name reaches every screen through the session.
      if (updated.assistantName !== branding?.assistantName) void refreshUser();
    } catch (err) {
      toast.error(errorText(err, 'Save failed.'));
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (file: File) => {
    if (file.size > ORG_LOGO_MAX_BYTES) return void toast.error(`The logo is at most ${Math.round(ORG_LOGO_MAX_BYTES / 1024)} KB.`);
    if (!ORG_LOGO_ALLOWED_TYPES.includes(file.type as never)) return void toast.error('The logo is a PNG, JPEG, WebP or SVG file.');
    setLogoBusy(true);
    try {
      const updated = await uploadOrgLogo(file);
      qc.setQueryData(ORG_SETTINGS_KEY, updated);
      setLogoBust((n) => n + 1);
      toast.success('Logo uploaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setLogoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onRemoveLogo = async () => {
    // The logo heads every outbound email — deleting it deserves a pause.
    if (!(await confirm({ title: 'Remove the logo?', description: 'Emails and letterheads use the default header until a new logo is uploaded.', destructive: true }))) return;
    setLogoBusy(true);
    try {
      await deleteOrgLogo();
      await q.refetch();
      toast.success('Logo removed.');
    } catch (err) {
      toast.error(errorText(err, 'Remove failed.'));
    } finally {
      setLogoBusy(false);
    }
  };

  const logoUrl = branding?.logoUrl ? `/api${branding.logoUrl}${branding.logoUrl.includes('?') ? '&' : '?'}c=${logoBust}` : null;
  const off = !canManage || saving;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Branding"
        subtitle="The name, sender, support address, colour and logo on every email, and what your team calls the assistant."
        related={[
          { label: 'Organization', to: '/admin/organization' },
          { label: 'Communications', to: '/admin/communications' },
        ]}
      />
      <p className="text-sm text-ink-muted">
        Looking for something that used to be here? Two-step sign-in is on{' '}
        <Link to="/admin/sign-in" className="text-accent underline underline-offset-2">
          Sign-in
        </Link>
        , the finance mailbox and remit-to on{' '}
        <Link to="/admin/finance" className="text-accent underline underline-offset-2">
          Finance
        </Link>
        , second-person rules on{' '}
        <Link to="/admin/approvals" className="text-accent underline underline-offset-2">
          Approval rules
        </Link>
        , and the workweek and time zone on{' '}
        <Link to="/admin/organization" className="text-accent underline underline-offset-2">
          Organization
        </Link>
        .
      </p>

      {q.isError ? (
        <QueryError what="branding" query={q} />
      ) : !draft ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] [&>*]:min-w-0">
            <SettingsSection title="Identity">
              <div className="space-y-4">
                <Field label="Organization name" hint="In the email header and the signature. Up to 120 characters." error={!nameValid ? "Enter your organization's name." : undefined}>
                  {(p) => <Input {...p} value={draft.orgName} onChange={(e) => set('orgName', e.target.value)} maxLength={120} placeholder="Your organization's name" disabled={off} />}
                </Field>
                <Field
                  label={ASSISTANT_NAME_PROMPT}
                  hint={`I'm the AI assistant in ${PRODUCT_NAME}. This is the name your team sees on WhatsApp and in every message I send; I always say I'm an AI assistant and who answers for me.`}
                >
                  {(p) => <Input {...p} value={draft.assistantName} onChange={(e) => set('assistantName', e.target.value)} maxLength={60} placeholder={ASSISTANT_PLATFORM_NAME} disabled={off} />}
                </Field>
                <Field label="Sender name" hint="The name on the From line, like “Acme HR”. Leave blank to use the default sender.">
                  {(p) => <Input {...p} value={draft.senderName} onChange={(e) => set('senderName', e.target.value)} maxLength={120} placeholder="Your organization's name" disabled={off} />}
                </Field>
                <Field
                  label="Support email"
                  hint="The address in every email's signature."
                  error={touched.supportEmail && !emailValid ? 'Enter a valid email address.' : undefined}
                >
                  {(p) => (
                    <Input
                      {...p}
                      type="email"
                      value={draft.supportEmail}
                      onChange={(e) => set('supportEmail', e.target.value)}
                      onBlur={() => setTouched((t) => ({ ...t, supportEmail: true }))}
                      maxLength={254}
                      placeholder="hr@example.com"
                      disabled={off}
                    />
                  )}
                </Field>
                <Field
                  label="Primary colour"
                  hint="The email header band and its button. A hex value: #RRGGBB."
                  error={touched.primaryColor && !colorValid ? `Use a hex value like ${DEFAULT_BRAND_PRIMARY}.` : undefined}
                >
                  {(p) => (
                    <div className="flex items-center gap-2">
                      <Input
                        {...p}
                        value={draft.primaryColor}
                        onChange={(e) => set('primaryColor', e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, primaryColor: true }))}
                        placeholder={DEFAULT_BRAND_PRIMARY}
                        maxLength={7}
                        className="max-w-[10rem] font-mono"
                        disabled={off}
                      />
                      <div
                        className="h-9 w-9 shrink-0 rounded border border-line"
                        style={{ background: colorValid && draft.primaryColor !== '' ? draft.primaryColor : DEFAULT_BRAND_PRIMARY }}
                        aria-hidden
                      />
                    </div>
                  )}
                </Field>
              </div>
            </SettingsSection>

            <SettingsSection title="Logo" description={`PNG, JPEG, WebP or SVG, up to ${Math.round(ORG_LOGO_MAX_BYTES / 1024)} KB. It shows even when the reader blocks images.`}>
              <div className="flex min-h-[140px] items-center justify-center rounded-lg border border-line bg-surface-raised/40 p-6">
                {logoUrl ? <img src={logoUrl} alt="Current logo" className="max-h-24 max-w-full" /> : <div className="text-sm text-ink-muted">No logo on file.</div>}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ORG_LOGO_ALLOWED_TYPES.join(',')}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onUpload(f);
                }}
              />
              {canManage && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={logoBusy}>
                    <ImagePlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
                    {logoUrl ? 'Replace' : 'Upload'}
                  </Button>
                  {logoUrl && (
                    <Button variant="outline" onClick={() => void onRemoveLogo()} disabled={logoBusy}>
                      <Trash2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
                      Remove
                    </Button>
                  )}
                </div>
              )}
              {branding?.logoUpdatedAt && <p className="mt-2 text-xs text-ink-muted">Last updated {fmtDateTime(branding.logoUpdatedAt)}</p>}
            </SettingsSection>
          </div>
          {canManage && <SettingsSaveBar dirty={dirty} saving={saving} disabled={!nameValid || !colorValid || !emailValid} onSave={() => void onSave()} onDiscard={() => setDraft(saved)} note="The logo saves on upload." />}
        </>
      )}
    </div>
  );
}

export default BrandingHome;
