import { useEffect, useRef, useState } from 'react';
import { ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  HEX_COLOR_REGEX,
  ORG_LOGO_ALLOWED_TYPES,
  ORG_LOGO_MAX_BYTES,
  type OrgBranding,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  deleteOrgLogo,
  getOrgBranding,
  patchOrgBranding,
  uploadOrgLogo,
} from '@/lib/brandingApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * HR-only org branding admin. Lets the org overlay its name, sender display
 * name, support email, primary brand colour, and logo onto every outbound
 * transactional email. Saved values cache for 5 minutes server-side, but
 * the API also refreshes the cache on every PATCH so changes appear in the
 * very next email rendered.
 */
export function BrandingHome() {
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [orgName, setOrgName] = useState('Alto HR');
  const [senderName, setSenderName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [logoBust, setLogoBust] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await getOrgBranding();
      setBranding(b);
      setOrgName(b.orgName);
      setSenderName(b.senderName ?? '');
      setSupportEmail(b.supportEmail ?? '');
      setPrimaryColor(b.primaryColor ?? '');
      setLogoBust((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load branding.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const colorValid = primaryColor === '' || HEX_COLOR_REGEX.test(primaryColor);
  const emailValid =
    supportEmail === '' || /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(supportEmail);

  const onSave = async () => {
    if (!colorValid) {
      toast.error('Primary colour must be a #RRGGBB hex value.');
      return;
    }
    if (!emailValid) {
      toast.error('Support email must be a bare address like info@example.com.');
      return;
    }
    setSaving(true);
    try {
      const updated = await patchOrgBranding({
        orgName: orgName.trim() || 'Alto HR',
        senderName: senderName.trim() === '' ? null : senderName.trim(),
        supportEmail: supportEmail.trim() === '' ? null : supportEmail.trim(),
        primaryColor: primaryColor.trim() === '' ? null : primaryColor.trim(),
      });
      setBranding(updated);
      toast.success('Branding saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (file: File) => {
    if (file.size > ORG_LOGO_MAX_BYTES) {
      toast.error(`Logo must be ≤ ${Math.round(ORG_LOGO_MAX_BYTES / 1024)} KB.`);
      return;
    }
    if (!ORG_LOGO_ALLOWED_TYPES.includes(file.type as never)) {
      toast.error(`Logo must be one of ${ORG_LOGO_ALLOWED_TYPES.join(', ')}.`);
      return;
    }
    setSaving(true);
    try {
      const updated = await uploadOrgLogo(file);
      setBranding(updated);
      setLogoBust((n) => n + 1);
      toast.success('Logo uploaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setSaving(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onRemoveLogo = async () => {
    setSaving(true);
    try {
      await deleteOrgLogo();
      await load();
      toast.success('Logo removed.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Remove failed.');
    } finally {
      setSaving(false);
    }
  };

  const logoUrl = branding?.logoUrl
    ? `/api${branding.logoUrl}${branding.logoUrl.includes('?') ? '&' : '?'}c=${logoBust}`
    : null;

  return (
    <div>
      <PageHeader
        title="Branding"
        subtitle="Org-wide overrides for the name, sender display, support email, primary colour, and logo shown on every outbound email."
        breadcrumbs={[
          { label: 'Home', to: '/' },
          { label: 'Branding' },
        ]}
        secondaryActions={
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Reload
          </Button>
        }
      />

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-alert text-sm">{error}</CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardContent className="p-6 space-y-4">
              <h2 className="font-display text-lg text-white">Identity</h2>
              <div className="space-y-1.5">
                <Label htmlFor="orgName">Organisation name</Label>
                <Input
                  id="orgName"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  maxLength={120}
                  placeholder="Alto HR"
                />
                <p className="text-silver/70 text-xs">
                  Shown in the email header bar (uppercased) and signature
                  block. Maxes out at 120 characters.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="senderName">Sender display name</Label>
                <Input
                  id="senderName"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  maxLength={120}
                  placeholder="Alto HR"
                />
                <p className="text-silver/70 text-xs">
                  Overlaid as the display name on the From: header (e.g.
                  "Alto HR &lt;hr@altohr.com&gt;"). Leave blank to use the
                  raw RESEND_FROM env value.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="supportEmail">Support email</Label>
                <Input
                  id="supportEmail"
                  type="email"
                  value={supportEmail}
                  onChange={(e) => setSupportEmail(e.target.value)}
                  maxLength={254}
                  placeholder="info@altohr.com"
                  aria-invalid={!emailValid}
                />
                <p className="text-silver/70 text-xs">
                  Address shown in the email signature footer. Replaces the
                  default <code>hr@altohr.com</code>.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="primaryColor">Primary colour</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="primaryColor"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    placeholder="#0F2A44"
                    maxLength={7}
                    aria-invalid={!colorValid}
                    className="font-mono"
                  />
                  <div
                    className="h-9 w-9 rounded border border-navy-secondary"
                    style={{
                      background:
                        colorValid && primaryColor !== '' ? primaryColor : '#0F2A44',
                    }}
                    aria-hidden
                  />
                </div>
                <p className="text-silver/70 text-xs">
                  Hex format only (<code>#RRGGBB</code>). Used for the email
                  header band and CTA button background.
                </p>
              </div>
              <div className="pt-2">
                <Button onClick={() => void onSave()} disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 space-y-4">
              <h2 className="font-display text-lg text-white">Logo</h2>
              <p className="text-silver/80 text-sm">
                Embedded inline in HTML emails as a data: URI so it renders
                even when the recipient blocks remote images. PNG, JPEG,
                WebP, or SVG; up to {Math.round(ORG_LOGO_MAX_BYTES / 1024)} KB.
              </p>
              <div className="bg-navy-secondary/40 rounded-lg p-6 flex items-center justify-center min-h-[140px] border border-navy-secondary">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt="Current logo"
                    className="max-h-24 max-w-full"
                  />
                ) : (
                  <div className="text-silver/60 text-sm">No logo on file.</div>
                )}
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
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving}
                >
                  <ImagePlus className="h-4 w-4 mr-1.5" />
                  {logoUrl ? 'Replace' : 'Upload'}
                </Button>
                {logoUrl && (
                  <Button
                    variant="outline"
                    onClick={() => void onRemoveLogo()}
                    disabled={saving}
                  >
                    <Trash2 className="h-4 w-4 mr-1.5" />
                    Remove
                  </Button>
                )}
              </div>
              {branding?.logoUpdatedAt && (
                <p className="text-silver/60 text-xs">
                  Last updated{' '}
                  {new Date(branding.logoUpdatedAt).toLocaleString()}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

export default BrandingHome;
