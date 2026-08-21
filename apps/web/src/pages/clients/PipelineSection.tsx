import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * New-business pipeline — the diversification ledger behind the executive
 * dashboard's concentration card. Admins (manage:clients) track prospects
 * through LEAD → CONTACTED → PROPOSAL → VERBAL → WON/LOST; a WON prospect
 * becomes a real Client through the normal "New client" flow.
 */

interface Prospect {
  id: string;
  name: string;
  stage: string;
  estWeeklyHours: number | null;
  estBillRate: number | null;
  notes: string | null;
  updatedAt: string;
}

const STAGES = ['LEAD', 'CONTACTED', 'PROPOSAL', 'VERBAL', 'WON', 'LOST'] as const;
const STAGE_TONE: Record<string, 'default' | 'pending' | 'success' | 'destructive'> = {
  LEAD: 'default',
  CONTACTED: 'pending',
  PROPOSAL: 'pending',
  VERBAL: 'pending',
  WON: 'success',
  LOST: 'destructive',
};

export function PipelineSection() {
  const [rows, setRows] = useState<Prospect[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [hours, setHours] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setError(null);
    apiFetch<{ prospects: Prospect[] }>('/executive/prospects')
      .then((r) => setRows(r.prospects))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load the pipeline.'),
      );
  };
  useEffect(load, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || name.trim().length < 2) return;
    setBusy('add');
    try {
      await apiFetch('/executive/prospects', {
        method: 'POST',
        body: {
          name: name.trim(),
          estWeeklyHours: hours ? Number(hours) : null,
          estBillRate: rate ? Number(rate) : null,
        },
      });
      toast.success('Prospect added to the pipeline.');
      setName('');
      setHours('');
      setRate('');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add the prospect.');
    } finally {
      setBusy(null);
    }
  };

  const setStage = async (p: Prospect, stage: string) => {
    if (busy) return;
    setBusy(p.id);
    try {
      await apiFetch(`/executive/prospects/${p.id}`, { method: 'PATCH', body: { stage } });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the stage.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Prospect) => {
    if (busy) return;
    setBusy(p.id);
    try {
      await apiFetch(`/executive/prospects/${p.id}`, { method: 'DELETE' });
      toast.success('Prospect removed.');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the prospect.');
    } finally {
      setBusy(null);
    }
  };

  const open = (rows ?? []).filter((r) => r.stage !== 'WON' && r.stage !== 'LOST');
  const potential = open.reduce(
    (n, p) => n + (p.estWeeklyHours && p.estBillRate ? p.estWeeklyHours * p.estBillRate : 0),
    0,
  );

  return (
    <Card className="mt-6">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">New-business pipeline</CardTitle>
          {open.length > 0 && potential > 0 && (
            <span className="text-xs text-silver">
              {open.length} open · potential {fmtMoney(potential)}/week billed
            </span>
          )}
        </div>
        <p className="text-xs text-silver">
          The hedge against single-client concentration — tracked here, surfaced on the
          executive dashboard. A won prospect becomes a client via “New client”.
        </p>
      </CardHeader>
      <CardContent>
        {error && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={load}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!rows && !error && <Skeleton className="h-24" />}
        {rows && (
          <>
            {rows.length === 0 ? (
              <p className="mb-3 text-sm text-silver">No prospects yet — add the first below.</p>
            ) : (
              <ul className="mb-3 divide-y divide-navy-secondary/60">
                {rows.map((p) => (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-white">{p.name}</span>
                      <Badge variant={STAGE_TONE[p.stage] ?? 'default'}>
                        {p.stage.toLowerCase()}
                      </Badge>
                      {p.estWeeklyHours && p.estBillRate && (
                        <span className="text-xs tabular-nums text-silver">
                          ~{fmtMoney(p.estWeeklyHours * p.estBillRate)}/wk
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Select
                        size="sm"
                        className="w-auto"
                        value={p.stage}
                        disabled={busy !== null}
                        onChange={(e) => void setStage(p, e.target.value)}
                        aria-label={`Stage for ${p.name}`}
                      >
                        {STAGES.map((s) => (
                          <option key={s} value={s}>
                            {s.toLowerCase()}
                          </option>
                        ))}
                      </Select>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void remove(p)}
                        aria-label={`Remove ${p.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={add} className="flex flex-wrap items-end gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prospect name (e.g. Target Panama City)"
                className="h-9 w-64 text-sm"
                aria-label="Prospect name"
              />
              <Input
                type="number"
                min="0"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="Est. hrs/wk"
                className="h-9 w-28 text-sm"
                aria-label="Estimated weekly hours"
              />
              <Input
                type="number"
                min="0"
                step="0.01"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="Bill $/h"
                className="h-9 w-24 text-sm"
                aria-label="Estimated bill rate"
              />
              <Button
                type="submit"
                size="sm"
                loading={busy === 'add'}
                disabled={busy !== null || name.trim().length < 2}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add prospect
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
