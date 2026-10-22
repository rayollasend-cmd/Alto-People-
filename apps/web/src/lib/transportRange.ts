import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ymdLocal } from './format';
import { workweekStart } from './workweek';

/**
 * Transport walk 13 — one date range for the Charges tab, kept in the URL
 * (`/transport?tab=charges&from=…&to=…`) and shared by every section on
 * it (the charges table, cost per seat, repeat no-shows). Default: the
 * last two Sat→Fri workweeks, a biweekly period's shape.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function defaultChargesRange(now = new Date()): { from: string; to: string } {
  const start = workweekStart(now);
  start.setDate(start.getDate() - 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return { from: ymdLocal(start), to: ymdLocal(end) };
}

export function useChargesRange(): { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void } {
  const [params, setParams] = useSearchParams();
  const fallback = useMemo(() => defaultChargesRange(), []);
  const from = YMD.test(params.get('from') ?? '') ? params.get('from')! : fallback.from;
  const to = YMD.test(params.get('to') ?? '') ? params.get('to')! : fallback.to;
  const set = (key: 'from' | 'to') => (v: string) => {
    if (!YMD.test(v)) return;
    const next = new URLSearchParams(params);
    next.set('from', key === 'from' ? v : from);
    next.set('to', key === 'to' ? v : to);
    setParams(next, { replace: true });
  };
  return { from, to, setFrom: set('from'), setTo: set('to') };
}
