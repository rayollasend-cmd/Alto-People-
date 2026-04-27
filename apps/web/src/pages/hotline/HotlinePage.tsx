import { useState } from 'react';
import { ShieldQuestion, FileText, Search } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
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
    <div className="min-h-screen bg-midnight text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center gap-3 mb-2">
          <ShieldQuestion className="h-7 w-7 text-blue-300" />
          <h1 className="text-2xl font-semibold">Confidential Reporting</h1>
        </div>
        <p className="text-sm text-silver mb-8">
          Report concerns anonymously. We never see your identity unless you
          choose to share a contact email. You will receive a tracking code so
          you can follow up later.
        </p>

        <div className="flex gap-2 mb-6 border-b border-navy-secondary">
          <button
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              mode === 'file'
                ? 'border-blue-300 text-white'
                : 'border-transparent text-silver hover:text-white'
            }`}
            onClick={() => {
              setMode('file');
              setFiled(null);
            }}
          >
            <FileText className="inline-block h-4 w-4 mr-2" />
            File a report
          </button>
          <button
            className={`px-4 py-2 text-sm border-b-2 -mb-px ${
              mode === 'lookup'
                ? 'border-blue-300 text-white'
                : 'border-transparent text-silver hover:text-white'
            }`}
            onClick={() => setMode('lookup')}
          >
            <Search className="inline-block h-4 w-4 mr-2" />
            Look up a report
          </button>
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
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Category</label>
        <select
          className="w-full bg-midnight border border-navy-secondary rounded p-2 text-white"
          value={category}
          onChange={(e) => setCategory(e.target.value as ReportCategory)}
        >
          {(Object.keys(CATEGORY_LABELS) as ReportCategory[]).map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Subject</label>
        <input
          className="w-full bg-midnight border border-navy-secondary rounded p-2 text-white"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Short headline of the concern"
          maxLength={200}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">What happened?</label>
        <textarea
          className="w-full h-40 bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the events, who was involved, when and where it happened. Be as specific as you can — but do not include your own name unless you choose to."
          maxLength={20000}
        />
        <div className="text-xs text-silver mt-1">
          {description.length} / 20,000 characters
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          Contact email <span className="text-silver">(optional)</span>
        </label>
        <input
          type="email"
          className="w-full bg-midnight border border-navy-secondary rounded p-2 text-white"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="leave blank to stay fully anonymous"
        />
        <div className="text-xs text-silver mt-1">
          Only fill this in if you want HR to be able to reach you directly.
          You can still follow up using your tracking code without it.
        </div>
      </div>

      <button
        className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded py-2.5 text-sm font-medium disabled:opacity-50"
        onClick={submit}
        disabled={busy}
      >
        {busy ? 'Submitting…' : 'Submit report'}
      </button>
    </div>
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
      <div className="rounded border border-green-700 bg-green-900/20 p-4">
        <div className="text-sm font-semibold text-green-300 mb-2">
          Report received.
        </div>
        <div className="text-sm text-white mb-3">
          Save this tracking code. It is the only way to check status or send
          follow-up messages later.
        </div>
        <div className="font-mono text-xl tracking-wider bg-midnight border border-navy-secondary rounded p-3 text-center">
          {code}
        </div>
      </div>
      <div className="text-xs text-silver">
        Write it down or screenshot this screen now. We cannot recover the code
        if you lose it.
      </div>
      <div className="flex gap-2">
        <button
          className="flex-1 bg-blue-600 hover:bg-blue-500 text-white rounded py-2 text-sm"
          onClick={onLookup}
        >
          Check status now
        </button>
        <button
          className="flex-1 bg-navy-secondary hover:bg-navy text-white rounded py-2 text-sm"
          onClick={onAnother}
        >
          File another
        </button>
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
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            Tracking code
          </label>
          <input
            className="w-full bg-midnight border border-navy-secondary rounded p-2 text-white font-mono tracking-wider uppercase"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="e.g. 7K2P9XQR3WN5HT4M"
            maxLength={32}
          />
        </div>
        <button
          className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded py-2.5 text-sm font-medium disabled:opacity-50"
          onClick={lookup}
          disabled={busy}
        >
          {busy ? 'Looking up…' : 'Look up'}
        </button>
      </div>
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
      <div className="rounded border border-navy-secondary p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="text-base font-semibold">{report.subject}</div>
          <span className="text-xs px-2 py-1 rounded bg-blue-900/40 text-blue-200 whitespace-nowrap">
            {report.status}
          </span>
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
            <div className="text-xs font-semibold text-green-300 mb-1">
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
                className={`rounded p-3 text-sm ${
                  u.isFromReporter
                    ? 'bg-blue-900/30 border border-blue-700/30'
                    : 'bg-navy-secondary'
                }`}
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
          <label className="block text-sm font-medium">
            Add a follow-up message
          </label>
          <textarea
            className="w-full h-24 bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Additional details, questions for HR…"
            maxLength={20000}
          />
          <button
            className="bg-blue-600 hover:bg-blue-500 text-white rounded px-4 py-2 text-sm disabled:opacity-50"
            onClick={sendReply}
            disabled={busy || !reply.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
