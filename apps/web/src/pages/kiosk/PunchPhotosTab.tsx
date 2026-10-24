import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CameraOff } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, parseYmd } from '@/lib/format';
import { listKioskDevices } from '@/lib/kiosk99Api';
import { endPunchPhotoRule, getPunchPhotoOverview, setPunchPhotoRule, type PunchPhotoRule } from '@/lib/punchPhotosApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';

/**
 * Kiosk → Photos: who must be photographed at punch. A company-wide switch,
 * a rule per client or location (required, or exempt from the company's),
 * and the people with a rule of their own — set from their record, listed
 * here with the reason and end date. Most specific wins.
 */

const day = (ymd: string) => fmtDate(parseYmd(ymd) ?? ymd);

export function PunchPhotosTab({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const hasClients = useTenant().moduleOn('clientPortal');
  const overview = useQuery({ queryKey: ['punchPhotos'], queryFn: getPunchPhotoOverview });
  const devices = useQuery({ queryKey: ['kiosk', 'devices'], queryFn: () => listKioskDevices() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['punchPhotos'] });

  const set = useMutation({
    mutationFn: setPunchPhotoRule,
    onSuccess: (r) => {
      toast.success(r.rule.label);
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const end = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => endPunchPhotoRule(id, reason),
    onSuccess: () => {
      toast.success('Rule ended.');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not end it.'),
  });

  // The places a rule can name: the locations (and their clients) that have a kiosk.
  const places = useMemo(() => {
    const sites = new Map<string, { id: string; name: string; clientId: string | null; clientName: string }>();
    const clients = new Map<string, string>();
    for (const d of devices.data?.devices ?? []) {
      if (d.locationId && d.locationName) sites.set(d.locationId, { id: d.locationId, name: d.locationName, clientId: d.clientId, clientName: d.clientName });
      if (d.clientId) clients.set(d.clientId, d.clientName);
    }
    return { sites: [...sites.values()].sort((a, b) => a.name.localeCompare(b.name)), clients: [...clients.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) };
  }, [devices.data]);

  const [pick, setPick] = useState('');

  if (overview.isPending) return <Skeleton className="h-64" />;
  if (overview.isError) return <QueryError what="the photo rules" query={overview} />;
  const o = overview.data;
  const companyOn = !!o.company?.required;

  const endRule = async (r: PunchPhotoRule) => {
    const reason = await prompt({ title: `End “${r.label}”?`, description: 'The next broader rule applies again.', reasonLabel: 'Why', confirmLabel: 'End it' });
    if (reason) end.mutate({ id: r.id, reason });
  };
  const addPlace = (required: boolean) => {
    const [kind, id] = pick.split(':') as ['site' | 'client', string];
    if (!id) return;
    set.mutate(kind === 'site' ? { scope: 'SITE', siteId: id, required } : { scope: 'CLIENT', clientId: id, required });
    setPick('');
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Company-wide" value={companyOn ? 'Required' : 'Not required'} hint={o.company ? `Since ${day(o.company.startsOn)}${o.company.setBy ? ` · ${o.company.setBy}` : ''}` : 'No company rule'} />
        <MetricCard label="People with their own rule" value={String(o.people.length)} hint="Set from each person’s record" />
        <MetricCard label="Kept without a photo · 30 days" value={String(o.noPhotoPunchesLast30Days)} accent={o.noPhotoPunchesLast30Days > 0} hint="Camera down or offline — a supervisor confirms each" href="/time-attendance/kiosk?tab=review" />
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <SectionTitle
            as="h3"
            title="Every punch, company-wide"
            description="On: the kiosk photographs everyone at every punch and nobody can skip it. A broken camera never stops a punch — it goes to a supervisor to confirm."
            trailing={
              canManage ? (
                <Button size="sm" variant={companyOn ? 'secondary' : 'primary'} loading={set.isPending} onClick={() => set.mutate({ scope: 'COMPANY', required: !companyOn })}>
                  {companyOn ? (
                    <>
                      <CameraOff className="h-4 w-4" aria-hidden="true" /> Turn off
                    </>
                  ) : (
                    <>
                      <Camera className="h-4 w-4" aria-hidden="true" /> Require for everyone
                    </>
                  )}
                </Button>
              ) : null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <SectionTitle as="h3" title={hasClients ? 'Clients and locations' : 'Locations'} description="Require a photo at one location (or every location of a client) — or exempt one from the company rule." />
          {[...o.clients, ...o.sites].length === 0 ? (
            <p className="text-sm text-ink-muted">No location has its own rule.</p>
          ) : (
            <ul className="divide-y divide-line">
              {[...o.clients, ...o.sites].map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm text-ink">{r.siteName ?? r.clientName}</span>
                    <span className="block text-xs text-ink-muted">
                      {r.required ? 'Photo required' : 'Exempt'} · since {day(r.startsOn)}
                      {r.setBy ? ` · ${r.setBy}` : ''}
                    </span>
                  </span>
                  {canManage && (
                    <Button size="xs" variant="ghost" onClick={() => void endRule(r)}>
                      End
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[16rem] flex-1">
                <Select aria-label="Location" value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Choose a location…</option>
                  {places.sites.map((s) => (
                    <option key={s.id} value={`site:${s.id}`}>
                      {s.name}
                      {hasClients && s.clientName ? ` — ${s.clientName}` : ''}
                    </option>
                  ))}
                  {hasClients &&
                    places.clients.map((c) => (
                      <option key={c.id} value={`client:${c.id}`}>
                        Every {c.name} location
                      </option>
                    ))}
                </Select>
              </div>
              <Button size="sm" disabled={!pick} onClick={() => addPlace(true)}>
                Require there
              </Button>
              <Button size="sm" variant="secondary" disabled={!pick || !companyOn} onClick={() => addPlace(false)}>
                Exempt
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <SectionTitle as="h3" title="People" description="A person’s own rule wins over their location’s and the company’s. Set it on their record — with the reason and how long." />
          {o.people.length === 0 ? (
            <EmptyState icon={Camera} title="Nobody has a rule of their own" description="Open someone’s record, Time tab, to require a photo at their punches." />
          ) : (
            <ul className="divide-y divide-line">
              {o.people.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    <Link to={`/people/${r.associateId}?tab=time`} className="text-sm font-medium text-ink hover:text-gold hover:underline">
                      {r.associateName ?? 'Someone'}
                    </Link>
                    <span className="block text-xs text-ink-muted">
                      {r.required ? 'Photo required' : 'Exempt'} · since {day(r.startsOn)}
                      {r.endsOn ? ` · through ${day(r.endsOn)}` : ' · no end date'}
                      {r.setBy ? ` · ${r.setBy}` : ''}
                    </span>
                    {r.reason && <span className="mt-0.5 block text-sm text-ink">{r.reason}</span>}
                  </span>
                  <Badge variant={r.required ? 'accent' : 'outline'} size="sm">
                    {r.required ? 'Required' : 'Exempt'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {o.history.length > 0 && (
        <Card>
          <CardContent className="space-y-2 p-4">
            <SectionTitle as="h3" title="Ended" description="Rules that ended, newest first — kept for the record." />
            <ul className="divide-y divide-line">
              {o.history.slice(0, 20).map((r) => (
                <li key={r.id} className="py-2 text-sm">
                  <span className="text-ink">{r.label}</span>
                  <span className="block text-xs text-ink-muted">
                    {day(r.startsOn)} – {r.endedAt ? fmtDate(new Date(r.endedAt)) : ''}
                    {r.endedBy ? ` · ended by ${r.endedBy}` : ''}
                    {r.endReason ? ` · ${r.endReason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
