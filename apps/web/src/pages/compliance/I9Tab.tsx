import { useCallback, useEffect, useState } from 'react';
import type { I9DocumentList, I9Verification } from '@alto-people/shared';
import { listI9s, upsertI9 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

export function I9Tab({ canManage }: { canManage: boolean }) {
  const [filter, setFilter] = useState<'pending' | 'complete' | 'all'>('pending');
  const [rows, setRows] = useState<I9Verification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listI9s(filter);
      setRows(res.i9s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section>
      <div className="flex flex-wrap gap-2 mb-4">
        {(['pending', 'complete', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'px-3 py-1.5 rounded text-sm border transition capitalize',
              filter === f
                ? 'border-gold text-gold bg-gold/10'
                : 'border-navy-secondary text-silver hover:text-white'
            )}
          >
            {f}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!rows && <p className="text-silver">Loading…</p>}
      {rows && rows.length === 0 && (
        <p className="text-silver">No I-9 records match this filter.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="bg-navy border border-navy-secondary rounded-lg p-4"
            >
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="text-white">{r.associateName}</div>
                  <div className="text-xs text-silver">{r.associateEmail}</div>
                </div>
                <div className="flex items-center gap-3 text-xs text-silver">
                  <span className={r.section1CompletedAt ? 'text-emerald-300' : 'text-alert'}>
                    Sec 1: {r.section1CompletedAt ? '✓' : '✗'}
                  </span>
                  <span className={r.section2CompletedAt ? 'text-emerald-300' : 'text-alert'}>
                    Sec 2: {r.section2CompletedAt ? '✓' : '✗'}
                  </span>
                  {r.documentList && (
                    <span className="uppercase tracking-widest">{r.documentList}</span>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === r.id ? null : r.id)}
                      className="px-2 py-1 rounded border border-gold/40 text-gold hover:bg-gold/10"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
              {openId === r.id && canManage && (
                <I9EditForm
                  current={r}
                  onSaved={() => {
                    setOpenId(null);
                    refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function I9EditForm({ current, onSaved }: { current: I9Verification; onSaved: () => void }) {
  const [section1Done, setSection1Done] = useState(!!current.section1CompletedAt);
  const [section2Done, setSection2Done] = useState(!!current.section2CompletedAt);
  const [documentList, setDocumentList] = useState<I9DocumentList | ''>(
    current.documentList ?? ''
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    const now = new Date().toISOString();
    try {
      await upsertI9(current.associateId, {
        section1CompletedAt: section1Done ? current.section1CompletedAt ?? now : null,
        section2CompletedAt: section2Done ? current.section2CompletedAt ?? now : null,
        documentList: documentList === '' ? null : documentList,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white';

  return (
    <form onSubmit={handleSubmit} className="mt-4 pt-3 border-t border-navy-secondary space-y-3">
      <div className="flex flex-wrap gap-4 items-end">
        <label className="text-sm text-white flex items-center gap-2">
          <input
            type="checkbox"
            checked={section1Done}
            onChange={(e) => setSection1Done(e.target.checked)}
          />
          Section 1 complete
        </label>
        <label className="text-sm text-white flex items-center gap-2">
          <input
            type="checkbox"
            checked={section2Done}
            onChange={(e) => setSection2Done(e.target.checked)}
          />
          Section 2 complete (HR verifies)
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Document list
          </span>
          <select
            value={documentList}
            onChange={(e) => setDocumentList(e.target.value as I9DocumentList | '')}
            className={inputCls}
          >
            <option value="">—</option>
            <option value="LIST_A">List A</option>
            <option value="LIST_B_AND_C">Lists B + C</option>
          </select>
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
        {submitting ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
