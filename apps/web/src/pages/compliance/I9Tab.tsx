import { useCallback, useEffect, useState } from 'react';
import type { I9DocumentList, I9Verification } from '@alto-people/shared';
import { listI9s, upsertI9 } from '@/lib/complianceApi';
import {
  listI9Documents,
  submitI9Section2,
  type I9DocumentListItem,
} from '@/lib/i9Api';
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
          {rows.map((r) => {
            const sec1Done = !!r.section1CompletedAt;
            const sec2Done = !!r.section2CompletedAt;
            const showVerifierCard = canManage && sec1Done && !sec2Done && !!r.applicationId;
            return (
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
                    <span className={sec1Done ? 'text-emerald-300' : 'text-alert'}>
                      Sec 1: {sec1Done ? '✓' : '✗'}
                    </span>
                    <span className={sec2Done ? 'text-emerald-300' : 'text-alert'}>
                      Sec 2: {sec2Done ? '✓' : '✗'}
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
                        {showVerifierCard ? 'Verify Section 2' : 'Edit'}
                      </button>
                    )}
                  </div>
                </div>
                {openId === r.id && showVerifierCard && (
                  <Section2VerifierCard
                    applicationId={r.applicationId!}
                    onDone={() => {
                      setOpenId(null);
                      refresh();
                    }}
                  />
                )}
                {openId === r.id && canManage && !showVerifierCard && (
                  <I9EditForm
                    current={r}
                    onSaved={() => {
                      setOpenId(null);
                      refresh();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Section2VerifierCard({
  applicationId,
  onDone,
}: {
  applicationId: string;
  onDone: () => void;
}) {
  const [docs, setDocs] = useState<I9DocumentListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [documentList, setDocumentList] = useState<I9DocumentList>('LIST_A');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listI9Documents(applicationId)
      .then((res) => {
        if (!cancelled) setDocs(res.documents);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof ApiError ? err.message : 'Failed to load documents.');
          setDocs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId]);

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const minDocs = documentList === 'LIST_A' ? 1 : 2;
  const canSubmit = picked.size >= minDocs && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await submitI9Section2(applicationId, {
        documentList,
        supportingDocIds: Array.from(picked),
      });
      onDone();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 pt-3 border-t border-navy-secondary space-y-4">
      <div className="flex flex-wrap gap-3 items-center">
        <span className="block text-xs uppercase tracking-widest text-silver">
          Document list
        </span>
        {(['LIST_A', 'LIST_B_AND_C'] as const).map((opt) => (
          <label key={opt} className="text-sm text-white flex items-center gap-2">
            <input
              type="radio"
              name={`docList-${applicationId}`}
              value={opt}
              checked={documentList === opt}
              onChange={() => setDocumentList(opt)}
            />
            {opt === 'LIST_A' ? 'List A (identity + work auth in one doc)' : 'Lists B + C (identity + work auth)'}
          </label>
        ))}
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-alert">
          {loadError}
        </p>
      )}

      {docs === null && <p className="text-silver text-sm">Loading documents…</p>}
      {docs !== null && docs.length === 0 && !loadError && (
        <p className="text-silver text-sm">
          No supporting documents uploaded yet — the associate must upload photos
          of their ID before Section 2 can be verified.
        </p>
      )}

      {docs && docs.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-widest text-silver mb-2">
            Pick the documents you inspected (need at least {minDocs})
          </p>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {docs.map((doc) => {
              const isImage = doc.mimeType.startsWith('image/');
              const checked = picked.has(doc.id);
              return (
                <li key={doc.id}>
                  <label
                    className={cn(
                      'block p-2 rounded border cursor-pointer transition',
                      checked
                        ? 'border-gold bg-gold/10'
                        : 'border-navy-secondary hover:border-silver/40'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      onChange={() => togglePick(doc.id)}
                      aria-label={`${doc.kind} ${doc.side ?? ''}`.trim()}
                    />
                    <div className="aspect-[3/2] bg-navy-secondary rounded mb-2 overflow-hidden flex items-center justify-center">
                      {isImage ? (
                        <img
                          src={`/api/documents/${doc.id}/download`}
                          alt={`${doc.kind}${doc.side ? ` ${doc.side}` : ''}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="text-xs text-silver">PDF</span>
                      )}
                    </div>
                    <div className="text-xs text-white truncate">{doc.kind}</div>
                    <div className="text-[10px] text-silver">
                      {doc.side ?? 'document'} ·{' '}
                      <a
                        href={`/api/documents/${doc.id}/download`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-gold hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Open
                      </a>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {submitError && (
        <p role="alert" className="text-sm text-alert">
          {submitError}
        </p>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className={cn(
          'px-4 py-2 rounded text-sm font-medium transition',
          canSubmit
            ? 'bg-gold text-navy hover:bg-gold-bright'
            : 'bg-navy-secondary text-silver/50 cursor-not-allowed'
        )}
      >
        {submitting ? 'Verifying…' : `Verify Section 2 (${picked.size} doc${picked.size === 1 ? '' : 's'})`}
      </button>
    </div>
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
