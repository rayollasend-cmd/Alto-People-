import { useState } from 'react';
import { ShieldQuestion, FileText, Search } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import {
  fileAnonymousReport,
  lookupReportByCode,
  replyAsReporter,
  type PublicReport,
  type ReportCategory,
} from '@/lib/anonReport128Api';

const CATEGORY_LABELS: Record<ReportCategory, string> = {
  HARASSMENT: 'Harassment',
  DISCRIMINATION: 'Discrimination',
  ETHICS_VIOLATION: 'Ethics violation',
  FRAUD: 'Fraud / financial misconduct',
  SAFETY: 'Safety concern',
  RETALIATION: 'Retaliation',
  OTHER: 'Other',
};

/**
 * Public-facing hotline page. No authentication. Has two modes:
 *   1. File a new report → returns a tracking code.
 *   2. Look up a report by tracking code → see status + HR replies, post a reply.
 *
 * Deliberately NOT wrapped in <Layout> so it shows no nav/sidebar that could
 * identify a logged-in reporter shoulder-surfing near a filing employee.
 */
export function HotlinePage() {
  const [mode, setMode] = useState<'file' | 'lookup'>('file');
  const [filed, setFiled] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-gradient-to-br from-midnight via-navy to-navy-secondary text-white">
      <div className="max-w-2xl mx-auto px-4 py-12 md:px-6">
        <div className="flex items-center justify-center mb-6">
          <Logo size="lg" alt="Alto HR" />
        </div>
        <div className="flex items-center gap-3 mb-2">
          <ShieldQuestion className="h-7 w-7 text-gold" />
          <h1 className="font-display text-2xl md:text-3xl text-white">
            Confidential Reporting
          </h1>
        </div>
        <p className="text-sm text-silver mb-8">
          Report concerns anonymously. We never see your identity unless you
          choose to share a contact email. You will receive a tracking code so
          you can follow up later.
        </p>

        <div
          role="tablist"
          aria-label="Report mode"
          className="flex gap-2 mb-6 border-b border-navy-secondary"
        >
          <TabButton
            active={mode === 'file'}
            onClick={() => {
              setMode('file');
              setFiled(null);
            }}
            icon={FileText}
            label="File a report"
          />
          <TabButton
            active={mode === 'lookup'}
            onClick={() => setMode('lookup')}
            icon={Search}
            label="Look up a report"
          />
        </div>

        {mode === 'file' ? (
          filed ? (
            <FiledConfirmation
              code={filed}
              onLookup={() => {
                setMode('lookup');
                setFiled(null);
              }}
              onAnother={() => setFiled(null)}
            />
          ) : (
            <FileForm onFiled={setFiled} />
          )
        ) : (
          <LookupForm />
        )}
      </div>
    </div>
  );
}

function FileForm({ onFiled }: { onFiled: (code: string) => void }) {
  const [category, setCategory] = useState<ReportCategory>('HARASSMENT');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (subject.trim().length < 3) {
      toast.error('Subject must be at least 3 characters.');
      return;
    }
    if (description.trim().length < 20) {
      toast.error('Please describe what happened in at least 20 characters.');
      return;
    }
    setBusy(true);
    try {
      const r = await fileAnonymousReport({
        category,
        subject: subject.trim(),
        description: description.trim(),
        contactEmail: contactEmail.trim() || null,
      });
      onFiled(r.trackingCode);
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not submit your report. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <Field label="Category" required>
        {(p) => (
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as ReportCategory)}
            {...p}
          >
            {(Object.keys(CATEGORY_LABELS) as ReportCategory[]).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Subject" required>
        {(p) => (
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Short headline of the concern"
            maxLength={200}
            {...p}
          />
        )}
      </Field>

      <Field
        label="What happened?"
        required
        hint={`${description.length} / 20,000 characters`}
      >
        {(p) => (
          <Textarea
            rows={8}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the events, who was involved, when and where it happened. Be as specific as you can — but do not include your own name unless you choose to."
            maxLength={20000}
            {...p}
          />
        )}
      </Field>

      <Field
        label={
          <>
            Contact email <span className="text-silver/70">(optional)</span>
          </>
        }
        hint="Only fill this in if you want HR to be able to reach you directly. You can still follow up using your tracking code without it."
      >
        {(p) => (
          <Input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="leave blank to stay fully anonymous"
            autoComplete="email"
            {...p}
          />
        )}
      </Field>

      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={busy}
        disabled={busy}
      >
        {busy ? 'Submitting…' : 'Submit report'}
      </Button>
    </form>
  );
}

function FiledConfirmation({
  code,
  onLookup,
  onAnother,
}: {
  code: string;
  onLookup: () => void;
  onAnother: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-success/40 bg-success/10 p-4">
        <div className="text-sm font-semibold text-success mb-2">
          Report received.
        </div>
        <div className="text-sm text-white mb-3">
          Save this tracking code. It is the only way to check status or send
          follow-up messages later.
        </div>
        <div className="font-mono text-xl tracking-wider bg-navy border border-navy-secondary rounded-md p-3 text-center select-all">
          {code}
        </div>
      </div>
      <div className="text-xs text-silver">
        Write it down or screenshot this screen now. We cannot recover the code
        if you lose it.
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button onClick={onLookup} className="flex-1">
          Check status now
        </Button>
        <Button variant="ghost" onClick={onAnother} className="flex-1">
          File another
        </Button>
      </div>
    </div>
  );
}

function LookupForm() {
  const [code, setCode] = useState('');
  const [report, setReport] = useState<PublicReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  const lookup = async () => {
    if (code.trim().length < 8) {
      toast.error('Enter the full tracking code.');
      return;
    }
    setBusy(true);
    try {
      const r = await lookupReportByCode(code.trim().toUpperCase());
      setReport(r.report);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.error('No report with that code.');
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Lookup failed.');
      }
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    if (!reply.trim() || !report) return;
    setBusy(true);
    try {
      await replyAsReporter(report.trackingCode, reply.trim());
      setReply('');
      toast.success('Reply sent.');
      const r = await lookupReportByCode(report.trackingCode);
      setReport(r.report);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };

  if (!report) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void lookup();
        }}
        noValidate
      >
        <Field label="Tracking code" required>
          {(p) => (
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. 7K2P9XQR3WN5HT4M"
              maxLength={32}
              className="font-mono tracking-wider uppercase"
              autoComplete="off"
              {...p}
            />
          )}
        </Field>
        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={busy}
          disabled={busy}
        >
          {busy ? 'Looking up…' : 'Look up'}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs">
        <button
          className="text-silver hover:text-white"
          onClick={() => setReport(null)}
        >
          ← Back
        </button>
      </div>
      <div className="rounded-md border border-navy-secondary bg-navy/40 p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="text-base font-semibold">{report.subject}</div>
          <Badge variant="default" className="shrink-0">
            {report.status}
          </Badge>
        </div>
        <div className="text-xs text-silver">
          {CATEGORY_LABELS[report.category]} · Filed{' '}
          {new Date(report.createdAt).toLocaleDateString()}
        </div>
        <div className="text-sm text-white whitespace-pre-wrap pt-2 border-t border-navy-secondary">
          {report.description}
        </div>
        {report.resolution && (
          <div className="mt-3 pt-3 border-t border-navy-secondary">
            <div className="text-xs font-semibold text-success mb-1">
              Resolution
            </div>
            <div className="text-sm text-white whitespace-pre-wrap">
              {report.resolution}
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="text-sm font-medium mb-2">Conversation</div>
        {report.updates.length === 0 ? (
          <div className="text-xs text-silver italic">
            No replies yet. HR will respond here.
          </div>
        ) : (
          <div className="space-y-2">
            {report.updates.map((u) => (
              <div
                key={u.id}
                className={cn(
                  'rounded-md p-3 text-sm border',
                  u.isFromReporter
                    ? 'bg-gold/10 border-gold/30'
                    : 'bg-navy-secondary border-navy-secondary',
                )}
              >
                <div className="text-xs text-silver mb-1">
                  {u.isFromReporter ? 'You' : 'HR'} ·{' '}
                  {new Date(u.createdAt).toLocaleString()}
                </div>
                <div className="text-white whitespace-pre-wrap">{u.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {report.status !== 'CLOSED' && (
        <div className="space-y-2 pt-4 border-t border-navy-secondary">
          <Field label="Add a follow-up message">
            {(p) => (
              <Textarea
                rows={4}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Additional details, questions for HR…"
                maxLength={20000}
                {...p}
              />
            )}
          </Field>
          <Button
            onClick={() => void sendReply()}
            loading={busy}
            disabled={busy || !reply.trim()}
          >
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}

function TabButton({ active, onClick, icon: Icon, label }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2 text-sm border-b-2 -mb-px transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-t',
        active
          ? 'border-gold text-white'
          : 'border-transparent text-silver hover:text-white',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
