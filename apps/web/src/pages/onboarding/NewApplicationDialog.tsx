import { useEffect, useMemo, useState } from 'react';
import { Copy, Mail } from 'lucide-react';
import { toast } from 'sonner';
import type {
  ClientSummary,
  EmploymentType,
  OnboardingTemplate,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  createApplication,
  listClients,
  listTemplates,
} from '@/lib/onboardingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after a successful create so the parent can refetch. */
  onCreated: () => void;
}

/**
 * HR-only dialog. One submit triggers `POST /onboarding/applications`,
 * which atomically: creates the Associate (or finds existing), creates
 * the INVITED User, mints an InviteToken, instantiates the checklist
 * tasks from the chosen template, and queues the welcome email.
 *
 * If the API isn't configured with Resend, the response includes the
 * raw `inviteUrl` so HR can copy it into Slack / a manual email.
 */
export function NewApplicationDialog({ open, onOpenChange, onCreated }: Props) {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [templates, setTemplates] = useState<OnboardingTemplate[] | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [position, setPosition] = useState('');
  const [startDate, setStartDate] = useState('');
  const [clientId, setClientId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('W2_EMPLOYEE');

  const [submitting, setSubmitting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const reset = () => {
    setFirstName('');
    setLastName('');
    setEmail('');
    setPosition('');
    setStartDate('');
    setClientId('');
    setTemplateId('');
    setEmploymentType('W2_EMPLOYEE');
    setInviteLink(null);
  };

  // Load pickers once when the dialog opens. Keep cached for subsequent
  // opens within the same session — clients/templates don't change often.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!clients) {
      listClients()
        .then((r) => !cancelled && setClients(r.clients))
        .catch(() => !cancelled && setClients([]));
    }
    if (!templates) {
      listTemplates()
        .then((r) => !cancelled && setTemplates(r.templates))
        .catch(() => !cancelled && setTemplates([]));
    }
    return () => {
      cancelled = true;
    };
  }, [open, clients, templates]);

  // Filter templates to global + client-specific for the chosen client.
  const visibleTemplates = useMemo(() => {
    if (!templates) return [];
    if (!clientId) return templates;
    return templates.filter((t) => t.clientId === null || t.clientId === clientId);
  }, [templates, clientId]);

  // If the chosen template is hidden by a client switch, drop the selection.
  useEffect(() => {
    if (templateId && !visibleTemplates.some((t) => t.id === templateId)) {
      setTemplateId('');
    }
  }, [visibleTemplates, templateId]);

  const submit = async () => {
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      toast.error('Name and email are required');
      return;
    }
    if (!clientId) {
      toast.error('Pick a client');
      return;
    }
    if (!templateId) {
      toast.error('Pick an onboarding template');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createApplication({
        associateFirstName: firstName.trim(),
        associateLastName: lastName.trim(),
        associateEmail: email.trim(),
        clientId,
        templateId,
        employmentType,
        position: position.trim() || undefined,
        startDate: startDate ? new Date(`${startDate}T00:00:00.000Z`).toISOString() : undefined,
      });
      onCreated();
      if (res.inviteUrl) {
        // Dev-stub mode: keep the dialog open and surface the link so HR
        // can copy it. Closing only happens via the Close button below.
        setInviteLink(res.inviteUrl);
        toast.success('Application created — invite link ready to copy');
      } else {
        toast.success('Application created — invite emailed');
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not create application';
      toast.error('Could not create', { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New onboarding application</DialogTitle>
          <DialogDescription>
            Creates the application and sends a magic-link invite to the associate.
          </DialogDescription>
        </DialogHeader>

        {inviteLink ? (
          <InviteLinkPanel inviteLink={inviteLink} onCopy={copyLink} />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="na-first" required>
                  First name
                </Label>
                <Input
                  id="na-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  autoFocus
                />
              </div>
              <div>
                <Label htmlFor="na-last" required>
                  Last name
                </Label>
                <Input
                  id="na-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="na-email" required>
                Email
              </Label>
              <Input
                id="na-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="new.hire@example.com"
              />
              <FormHint>The magic link goes here. Lower-cased on the server.</FormHint>
            </div>

            <div>
              <Label htmlFor="na-client" required>
                Client
              </Label>
              <select
                id="na-client"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={clients === null}
                className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
              >
                <option value="">
                  {clients === null ? 'Loading…' : 'Pick a client'}
                </option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.state ? ` · ${c.state}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="na-template" required>
                Onboarding template
              </Label>
              <select
                id="na-template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={templates === null || !clientId}
                className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
              >
                <option value="">
                  {!clientId
                    ? 'Pick a client first'
                    : templates === null
                      ? 'Loading…'
                      : visibleTemplates.length === 0
                        ? 'No templates available for this client'
                        : 'Pick a template'}
                </option>
                {visibleTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {TRACK_LABEL[t.track] ?? t.track}
                    {t.clientId === null ? ' (global)' : ''}
                  </option>
                ))}
              </select>
              <FormHint>
                Global templates apply to any client; client-specific ones only show for that client.
              </FormHint>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="na-position">Position</Label>
                <Input
                  id="na-position"
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="Server"
                />
              </div>
              <div>
                <Label htmlFor="na-start">Start date</Label>
                <Input
                  id="na-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="na-emp-type">Employment type</Label>
              <select
                id="na-emp-type"
                value={employmentType}
                onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
                className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              >
                <option value="W2_EMPLOYEE">W-2 employee</option>
                <option value="CONTRACTOR_1099_INDIVIDUAL">1099 contractor (individual)</option>
                <option value="CONTRACTOR_1099_BUSINESS">1099 contractor (business)</option>
              </select>
              <FormHint>
                1099 contractors skip the W-4 task and are paid gross — no
                federal/state withholding, no FICA/Medicare, no employer
                payroll tax.
              </FormHint>
            </div>
          </div>
        )}

        <DialogFooter>
          {inviteLink ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} loading={submitting}>
                <Mail className="h-4 w-4" />
                Create &amp; invite
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteLinkPanel({
  inviteLink,
  onCopy,
}: {
  inviteLink: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
        Email delivery isn't configured (Resend env vars missing). Copy this
        link and send it to the associate yourself.
      </div>
      <div className="rounded-md border border-navy-secondary bg-navy/60 p-3 break-all font-mono text-xs text-silver">
        {inviteLink}
      </div>
      <Button variant="secondary" onClick={onCopy} className="w-full">
        <Copy className="h-4 w-4" />
        Copy link
      </Button>
    </div>
  );
}
