import { useCallback, useEffect, useState } from 'react';
import type { J1Profile } from '@alto-people/shared';
import { listJ1Profiles, upsertJ1 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';

function expiryClass(days: number): string {
  if (days < 0) return 'text-alert';
  if (days < 30) return 'text-gold';
  return 'text-silver';
}

export function J1Tab({ canManage }: { canManage: boolean }) {
  const [profiles, setProfiles] = useState<J1Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listJ1Profiles();
      setProfiles(res.profiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section>
      {canManage && (
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="mb-4 px-4 py-2 rounded font-medium bg-gold text-navy hover:bg-gold-bright"
        >
          {showCreate ? 'Close' : '+ Add / update J-1 profile'}
        </button>
      )}

      {showCreate && canManage && (
        <UpsertJ1Form
          onSaved={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!profiles && <p className="text-silver">Loading…</p>}
      {profiles && profiles.length === 0 && (
        <p className="text-silver">No J-1 profiles yet.</p>
      )}
      {profiles && profiles.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/40 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="px-4 py-3 text-left">Associate</th>
                <th className="px-4 py-3 text-left">Country</th>
                <th className="px-4 py-3 text-left">DS-2019</th>
                <th className="px-4 py-3 text-left">Sponsor</th>
                <th className="px-4 py-3 text-left">Program</th>
                <th className="px-4 py-3 text-left">Days left</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="border-t border-navy-secondary/60 text-white">
                  <td className="px-4 py-3">{p.associateName}</td>
                  <td className="px-4 py-3 text-silver">{p.country}</td>
                  <td className="px-4 py-3 text-silver">{p.ds2019Number}</td>
                  <td className="px-4 py-3 text-silver">{p.sponsorAgency}</td>
                  <td className="px-4 py-3 text-silver tabular-nums">
                    {p.programStartDate} → {p.programEndDate}
                  </td>
                  <td className={cn('px-4 py-3 tabular-nums', expiryClass(p.daysUntilEnd))}>
                    {p.daysUntilEnd}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UpsertJ1Form({ onSaved }: { onSaved: () => void }) {
  const [associateId, setAssociateId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [ds2019, setDs2019] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [country, setCountry] = useState('');
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
      await upsertJ1(associateId, {
        programStartDate: start,
        programEndDate: end,
        ds2019Number: ds2019,
        sponsorAgency: sponsor,
        country,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-5 p-4 bg-navy border border-navy-secondary rounded-lg space-y-3"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Associate ID
          </span>
          <input
            type="text"
            required
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Country
          </span>
          <input
            type="text"
            required
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Program start
          </span>
          <input
            type="date"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Program end
          </span>
          <input
            type="date"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            DS-2019 number
          </span>
          <input
            type="text"
            required
            value={ds2019}
            onChange={(e) => setDs2019(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-widest text-silver mb-1">
            Sponsor agency
          </span>
          <input
            type="text"
            required
            value={sponsor}
            onChange={(e) => setSponsor(e.target.value)}
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
        {submitting ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}
