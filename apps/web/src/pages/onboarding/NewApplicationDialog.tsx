import { useEffect, useMemo, useState } from 'react';
import { Copy, Mail } from 'lucide-react';
import { toast } from 'sonner';
import type {
  ClientSummary,
  EmploymentType,
  HireableRole,
  OnboardingTemplate,
} from '@alto-people/shared';
import { HIREABLE_ROLES } from '@alto-people/shared';
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
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

// Labels for the "Hire as" picker. Order matches HIREABLE_ROLES so the
// first option (ASSOCIATE) is the default and the management roles follow.
const HIRE_ROLE_LABEL: Record<HireableRole, string> = {
  ASSOCIATE: 'Associate (default)',
  OPERATIONS_MANAGER: 'Operations Manager',
  MANAGER: 'Manager',
  INTERNAL_RECRUITER: 'Internal Recruiter',
  WORKFORCE_MANAGER: 'Workforce Manager',
  MARKETING_MANAGER: 'Marketing Manager',
  FINANCE_ACCOUNTANT: 'Finance / Accountant',
};

// Pre-fill the Position field when HR picks a management role so the
// applicant's position matches the role they'll log in as. HR can still
// override if they want a more specific job title.
const HIRE_ROLE_POSITION: Record<HireableRole, string | null> = {
  ASSOCIATE: null,
  OPERATIONS_MANAGER: 'Operations Manager',
  MANAGER: 'Manager',
  INTERNAL_RECRUITER: 'Internal Recruiter',
  WORKFORCE_MANAGER: 'Workforce Manager',
  MARKETING_MANAGER: 'Marketing Manager',
  FINANCE_ACCOUNTANT: 'Finance / Accountant',
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
  const [hireRole, setHireRole] = useState<HireableRole>('ASSOCIATE');

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
    setHireRole('ASSOCIATE');
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
        // Only send hireRole when it differs from the default ASSOCIATE
        // so older bulk-invite test fixtures and the bulk endpoint stay
        // backwards compatible.
        ...(hireRole !== 'ASSOCIATE' ? { hireRole } : {}),
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="First name" required>
                {(p) => (
                  <Input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoFocus
                    {...p}
                  />
                )}
              </Field>
              <Field label="Last name" required>
                {(p) => (
                  <Input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    {...p}
                  />
                )}
              </Field>
            </div>

            <Field
              label="Email"
              required
              hint="The magic link goes here. Lower-cased on the server."
            >
              {(p) => (
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="new.hire@example.com"
                  {...p}
                />
              )}
            </Field>

            <Field
              label="Hire as"
              required
              hint="Associate is the default. Pick a management role to onboard a new manager via the same invite + checklist flow — they'll land in the correct sidebar on first login."
            >
              {(p) => (
                <Select
                  value={hireRole}
                  onChange={(e) => {
                    const next = e.target.value as HireableRole;
                    setHireRole(next);
                    // Pre-fill position with the role label when HR picks a
                    // management role and they haven't typed anything yet.
                    // Don't clobber a value HR already entered.
                    const prefill = HIRE_ROLE_POSITION[next];
                    if (prefill && !position.trim()) setPosition(prefill);
                  }}
                  {...p}
                >
                  {HIREABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {HIRE_ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Client"
              required
              hint={
                hireRole !== 'ASSOCIATE' ? (
                  <>
                    For management hires, pick the{' '}
                    <span className="text-white">Alto HR — Internal Hires</span>{' '}
                    client (or a specific client they'll oversee).
                  </>
                ) : undefined
              }
            >
              {(p) => (
                <Select
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  disabled={clients === null}
                  {...p}
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
                </Select>
              )}
            </Field>

            <Field
              label="Onboarding template"
              required
              hint="Global templates apply to any client; client-specific ones only show for that client."
            >
              {(p) => (
                <Select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  disabled={templates === null || !clientId}
                  {...p}
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
                </Select>
              )}
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Position">
                {(p) => (
                  <Input
                    value={position}
                    onChange={(e) => setPosition(e.target.value)}
                    placeholder="Server"
                    {...p}
                  />
                )}
              </Field>
              <Field label="Start date">
                {(p) => (
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    {...p}
                  />
                )}
              </Field>
            </div>

            <Field
              label="Employment type"
              hint="1099 contractors skip the W-4 task and are paid gross — no federal/state withholding, no FICA/Medicare, no employer payroll tax."
            >
              {(p) => (
                <Select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
                  {...p}
                >
                  <option value="W2_EMPLOYEE">W-2 employee</option>
                  <option value="CONTRACTOR_1099_INDIVIDUAL">1099 contractor (individual)</option>
                  <option value="CONTRACTOR_1099_BUSINESS">1099 contractor (business)</option>
                </Select>
              )}
            </Field>
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
      <div className="rounded-md border border-silver/30 bg-silver/[0.06] p-3 text-sm text-silver">
        Email delivery isn't configured. Copy this link and send it to the
        associate yourself (Slack, manual email, etc.).
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
