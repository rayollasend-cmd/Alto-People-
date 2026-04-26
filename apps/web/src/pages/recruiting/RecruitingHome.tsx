import { useCallback, useEffect, useState } from 'react';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  advanceCandidate,
  createCandidate,
  hireCandidate,
  listCandidates,
} from '@/lib/recruitingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

const STAGES: CandidateStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
];

const STAGE_CLS: Record<CandidateStage, string> = {
  APPLIED: 'text-silver',
  SCREENING: 'text-silver',
  INTERVIEW: 'text-gold',
  OFFER: 'text-gold',
  HIRED: 'text-emerald-300',
  WITHDRAWN: 'text-silver/60',
  REJECTED: 'text-alert',
};

const NEXT_STAGE: Partial<Record<CandidateStage, CandidateStage>> = {
  APPLIED: 'SCREENING',
  SCREENING: 'INTERVIEW',
  INTERVIEW: 'OFFER',
};

export function RecruitingHome() {
  const { can } = useAuth();
  const canManage = can('manage:recruiting');
  const [filter, setFilter] = useState<CandidateStage | 'ALL'>('APPLIED');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listCandidates(filter === 'ALL' ? {} : { stage: filter });
      setCandidates(res.candidates);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const advance = async (c: Candidate, target: CandidateStage) => {
    if (pendingId) return;
    setPendingId(c.id);
    try {
      const body: { stage: CandidateStage; rejectedReason?: string; withdrawnReason?: string } = {
        stage: target,
      };
      if (target === 'REJECTED') {
        const reason = window.prompt('Rejection reason?');
        if (!reason) {
          setPendingId(null);
          return;
        }
        body.rejectedReason = reason;
      }
      if (target === 'WITHDRAWN') {
        const reason = window.prompt('Withdrawal reason?');
        if (!reason) {
          setPendingId(null);
          return;
        }
        body.withdrawnReason = reason;
      }
      await advanceCandidate(c.id, body);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Advance failed.');
    } finally {
      setPendingId(null);
    }
  };

  const hire = async (c: Candidate) => {
    if (pendingId) return;
    if (!window.confirm(`Hire ${c.firstName} ${c.lastName}? An Associate will be created.`)) return;
    setPendingId(c.id);
    try {
      await hireCandidate(c.id);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Hire failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Recruiting
          </h1>
          <p className="text-silver">
            {canManage
              ? 'Manage candidates from application through hire.'
              : 'Read-only view of the candidate pipeline.'}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
          >
            {showCreate ? 'Close' : '+ New candidate'}
          </button>
        )}
      </header>

      {showCreate && canManage && (
        <CreateCandidateForm
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      <div className="flex flex-wrap gap-2 mb-5">
        {(['ALL', ...STAGES] as Array<CandidateStage | 'ALL'>).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition',
              filter === s
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!candidates && <p className="text-silver">Loading…</p>}
      {candidates && candidates.length === 0 && (
        <p className="text-silver">No candidates match this filter.</p>
      )}
      {candidates && candidates.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">Name</th>
                <th className="px-4 py-3 text-left">Email</th>
                <th className="px-4 py-3 text-left">Position</th>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-left">Stage</th>
                {canManage && <th className="px-4 py-3 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3">
                    {c.firstName} {c.lastName}
                  </td>
                  <td className="px-4 py-3 text-silver">{c.email}</td>
                  <td className="px-4 py-3 text-silver">{c.position ?? '—'}</td>
                  <td className="px-4 py-3 text-silver">{c.source ?? '—'}</td>
                  <td className={cn('px-4 py-3 text-xs uppercase tracking-widest', STAGE_CLS[c.stage])}>
                    {c.stage}
                    {c.rejectedReason && (
                      <div className="text-[10px] normal-case tracking-normal mt-1 text-alert">
                        {c.rejectedReason}
                      </div>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                      {NEXT_STAGE[c.stage] && (
                        <button
                          type="button"
                          onClick={() => advance(c, NEXT_STAGE[c.stage]!)}
                          disabled={pendingId === c.id}
                          className="text-xs px-2 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10 disabled:opacity-50"
                        >
                          → {NEXT_STAGE[c.stage]}
                        </button>
                      )}
                      {c.stage === 'OFFER' && (
                        <button
                          type="button"
                          onClick={() => hire(c)}
                          disabled={pendingId === c.id}
                          className="text-xs px-2 py-1 rounded border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50"
                        >
                          Hire
                        </button>
                      )}
                      {c.stage !== 'HIRED' && c.stage !== 'REJECTED' && c.stage !== 'WITHDRAWN' && (
                        <>
                          <button
                            type="button"
                            onClick={() => advance(c, 'WITHDRAWN')}
                            disabled={pendingId === c.id}
                            className="text-xs px-2 py-1 rounded border border-silver/30 text-silver hover:bg-silver/10 disabled:opacity-50"
                          >
                            Withdraw
                          </button>
                          <button
                            type="button"
                            onClick={() => advance(c, 'REJECTED')}
                            disabled={pendingId === c.id}
                            className="text-xs px-2 py-1 rounded border border-alert/40 text-alert hover:bg-alert/10 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateCandidateForm({ onCreated }: { onCreated: () => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createCandidate({
        firstName,
        lastName,
        email,
        phone: phone || undefined,
        position: position || undefined,
        source: source || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5 space-y-3"
    >
      <h2 className="font-display text-2xl text-white">New candidate</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            First name
          </span>
          <input
            type="text"
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Last name
          </span>
          <input
            type="text"
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Email
          </span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Phone
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Position
          </span>
          <input
            type="text"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Source
          </span>
          <input
            type="text"
            placeholder="referral / careers-page / indeed"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className={inputCls}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className={cn(
          'px-4 py-2 rounded text-sm font-medium transition',
          submitting
            ? 'bg-navy-secondary text-silver/50 cursor-not-allowed'
            : 'bg-gold text-navy hover:bg-gold-bright'
        )}
      >
        {submitting ? 'Saving…' : 'Save as APPLIED'}
      </button>
    </form>
  );
}
