import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Globe, Plane, Plus } from '@/components/ui/icons';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { sanitizeReturnPath } from './section2Verification';
import { WORKFORCE_PARAM, WorkforceFilter, useComplianceWorkforce } from './WorkforceFilter';
import { COMPLIANCE_WORKFORCE_LABELS, type ClearedShift, type J1Profile } from '@alto-people/shared';
import { listJ1Profiles, upsertJ1 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTz, fmtShiftRangeTz, parseYmd, ymdLocal } from '@/lib/format';
import { personPhotoUrl } from '@/lib/photoUrl';
import { PeopleStatusBadge, workStatusEnglish } from '@/components/ui/PeopleStatusBadge';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';

/**
 * J-1 participants (cleared to work, owner 2026-11-03). Opens on the current
 * workforce like every compliance tab; the program end is the one the
 * scheduling block reads (the later of this profile and an open Program
 * record), and each row says when the person is next scheduled — and flags
 * a shift booked after the program end, or a punch after it. The 30-day
 * grace period lets a participant stay in the country; it does not allow
 * work, so scheduling refuses those days.
 */

function expiryVariant(days: number): 'destructive' | 'pending' | 'default' {
  if (days < 0) return 'destructive';
  if (days <= 30) return 'pending';
  return 'default';
}

/** Days left in words: the last program day is "Last day", not −1 or 0d. Exported for the tests. */
export function daysLeftWords(days: number): string {
  if (days < 0) return `Ended ${-days}d ago`;
  if (days === 0) return 'Last day';
  return `${days}d left`;
}

type J1Filter = 'all' | 'active' | 'ending' | 'ended' | 'scheduled' | 'worked';
const J1_FILTERS: readonly J1Filter[] = ['all', 'active', 'ending', 'ended', 'scheduled', 'worked'];

function matches(p: J1Profile, f: J1Filter): boolean {
  if (f === 'active') return p.daysUntilEnd >= 0;
  if (f === 'ending') return p.daysUntilEnd >= 0 && p.daysUntilEnd <= 30;
  if (f === 'ended') return p.daysUntilEnd < 0;
  if (f === 'scheduled') return !!p.scheduledAfterEnd;
  if (f === 'worked') return !!p.workedAfterEndOn;
  return true;
}

const shiftWords = (s: ClearedShift) => `${fmtDateTz(s.startsAt, s.timezone)} · ${fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)} · ${s.position}${s.place ? ` at ${s.place}` : ''}`;

interface UpsertSeed {
  associateId: string;
  start: string;
  end: string;
  ds2019: string;
  sponsor: string;
  country: string;
}

const EMPTY_SEED: UpsertSeed = {
  associateId: '',
  start: '',
  end: '',
  ds2019: '',
  sponsor: '',
  country: '',
};

export function J1Tab({ canManage }: { canManage: boolean }) {
  // ?associateId= deep-links one participant (the scorecard's Fix links, the
  // application checklist and the Cleared to work tab send it) — auto-open
  // their drawer once the list arrives, on All so they are on it whatever
  // their group. ?return= is the surface the reviewer came from; ?status=
  // (ended | scheduled | worked | ending | active) and ?workforce= pick the
  // view for this visit. All are captured into state once, then consumed
  // (replace: true): ComplianceHome tab switches copy the current search
  // params, so lingering params would re-arm on every tab visit.
  const [deepLinkParams, setDeepLinkParams] = useSearchParams();
  const [deepLinkAssociateId] = useState<string | null>(() =>
    deepLinkParams.get('associateId'),
  );
  const [returnPath] = useState<string | null>(() =>
    sanitizeReturnPath(deepLinkParams.get('return')),
  );
  const [filter, setFilter] = useState<J1Filter>(() => {
    const v = deepLinkParams.get('status');
    return J1_FILTERS.find((f) => f === v) ?? 'all';
  });
  const { workforce, setWorkforce } = useComplianceWorkforce({ wide: !!deepLinkAssociateId });
  const deepLinkOpened = useRef(false);
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    if (!['associateId', 'return', 'status', WORKFORCE_PARAM].some((k) => deepLinkParams.has(k))) return;
    deepLinkConsumed.current = true;
    const params = new URLSearchParams(deepLinkParams);
    params.delete('associateId');
    params.delete('return');
    params.delete('status');
    params.delete(WORKFORCE_PARAM);
    setDeepLinkParams(params, { replace: true });
  }, [deepLinkParams, setDeepLinkParams]);
  const [drawerTarget, setDrawerTarget] = useState<J1Profile | null>(null);
  const [upsertSeed, setUpsertSeed] = useState<UpsertSeed | null>(null);
  const profilesQuery = useQuery({
    queryKey: ['J1Tab', 'profiles', workforce],
    queryFn: () => listJ1Profiles({ workforce }),
  });
  const profiles: J1Profile[] | null = profilesQuery.data?.profiles ?? null;
  const shown = useMemo(() => (profiles ?? []).filter((p) => matches(p, filter)), [profiles, filter]);
  const error = profilesQuery.error
    ? profilesQuery.error instanceof ApiError
      ? profilesQuery.error.message
      : 'Failed to load.'
    : null;
  // Keep the open drawer pointed at the fresh row after a reload.
  useEffect(() => {
    const res = profilesQuery.data;
    if (res === undefined) return;
    setDrawerTarget((prev) =>
      prev ? res.profiles.find((p) => p.associateId === prev.associateId) ?? null : null,
    );
  }, [profilesQuery.data]);
  const refresh = () => void profilesQuery.refetch();

  // Deep link: open the linked participant's drawer as soon as their row
  // arrives. No profile yet is a plain landing on the tab — the Add button
  // is right there.
  useEffect(() => {
    if (!deepLinkAssociateId || deepLinkOpened.current || !profiles) return;
    const match = profiles.find((p) => p.associateId === deepLinkAssociateId);
    if (match) {
      deepLinkOpened.current = true;
      setDrawerTarget(match);
    }
  }, [profiles, deepLinkAssociateId]);

  const openEditFromDrawer = () => {
    if (!drawerTarget) return;
    setUpsertSeed({
      associateId: drawerTarget.associateId,
      start: drawerTarget.programStartDate,
      end: drawerTarget.programEndDate,
      ds2019: drawerTarget.ds2019Number,
      sponsor: drawerTarget.sponsorAgency,
      country: drawerTarget.country,
    });
  };

  // The tiles count the rows of the chosen group, and each one is the filter it names.
  const all = profiles ?? [];
  const count = (f: J1Filter) => all.filter((p) => matches(p, f)).length;
  const tile = (f: J1Filter) => ({ active: filter === f, onClick: () => setFilter(filter === f ? 'all' : f) });
  const group = COMPLIANCE_WORKFORCE_LABELS[workforce].toLowerCase();

  return (
    <section>
      <DirectorateHeader
        icon={Plane}
        title="J-1 program"
        blurb="Exchange-visitor participants: DS-2019, sponsor and program dates. No work after the program ends, grace period or not."
        actions={
          canManage && (
            <Button onClick={() => setUpsertSeed(EMPTY_SEED)} size="sm">
              <Plus className="h-4 w-4" />
              Add / update profile
            </Button>
          )
        }
      />

      {profiles && profiles.length > 0 && (
        <KpiStrip>
          <Kpi label="Participants" value={all.length} hint={`J-1 participants in ${group === 'all' ? 'every group' : `the ${group} group`}.`} {...tile('all')} />
          <Kpi label="Active" value={count('active')} tone="text-success" hint="Program still running (today counts)." {...tile('active')} />
          <Kpi
            label="Ending ≤ 30d"
            value={count('ending')}
            tone={count('ending') > 0 ? 'text-warning' : undefined}
            hint="Program ends within 30 days: they may not work after it."
            {...tile('ending')}
          />
          <Kpi
            label="Program ended"
            value={count('ended')}
            tone={count('ended') > 0 ? 'text-alert' : undefined}
            hint="Program over. The grace period lets them stay in the country, not work."
            {...tile('ended')}
          />
          <Kpi
            label="Scheduled after end"
            value={count('scheduled')}
            tone={count('scheduled') > 0 ? 'text-alert' : undefined}
            hint="A shift is booked on a day after their program ends. Move it to someone else."
            {...tile('scheduled')}
          />
          <Kpi
            label="Worked after end"
            value={count('worked')}
            tone={count('worked') > 0 ? 'text-alert' : undefined}
            hint="Clocked in on a day after their program ended."
            {...tile('worked')}
          />
        </KpiStrip>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <WorkforceFilter value={workforce} onChange={setWorkforce} counts={profilesQuery.data?.workforceCounts} />
      </div>
      {profilesQuery.data?.truncated && (
        <p className="mb-2 text-xs text-warning">More profiles matched than this list carries. Narrow it with the group chips.</p>
      )}

      {error && (
        <ErrorBanner
          className="mb-3"
          action={
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          }
        >
          {error}
        </ErrorBanner>
      )}
      {!profiles && !error && <SkeletonRows count={4} rowHeight="h-12" />}
      {profiles && profiles.length === 0 && (
        <EmptyState
          icon={Globe}
          title={workforce === 'all' ? 'No J-1 profiles yet' : `No J-1 participants in ${group}`}
          description={
            workforce !== 'all'
              ? 'Pick another group above to see participants who left or are paused.'
              : canManage
                ? 'Add a J-1 profile for an associate when their DS-2019 paperwork is in hand.'
                : 'J-1 profiles will appear here once they are created.'
          }
          action={
            canManage && workforce === 'all' ? (
              <Button onClick={() => setUpsertSeed(EMPTY_SEED)} size="sm">
                <Plus className="h-4 w-4" />
                Add profile
              </Button>
            ) : undefined
          }
        />
      )}
      {profiles && profiles.length > 0 && (
        <TableShell>
        <DataGrid<J1Profile>
          id="j1-profiles"
          caption="J-1 profiles"
          rows={shown}
          rowKey={(pr) => pr.id}
          search={{ placeholder: 'Associate, country, sponsor…' }}
          urlState={false}
          exportCsv={{ filename: `j1-${workforce}-${ymdLocal()}` }}
          activeFilters={filter === 'all' ? 0 : 1}
          onClearFilters={() => setFilter('all')}
          onRowClick={(pr) => setDrawerTarget(pr)}
          rowActionLabel={(pr) => `Open ${pr.associateName}`}
          columns={[
            {
              key: 'associate',
              header: 'Associate',
              accessor: (pr) => pr.associateName,
              sortable: true,
              primary: true,
              className: 'font-medium',
              cell: (pr) => (
                <div className="flex items-center gap-2.5">
                  <Avatar src={personPhotoUrl({ photoUrl: pr.associatePhotoUrl, associateId: pr.associateId })} name={pr.associateName} email={pr.associateEmail} size="sm" />
                  <div className="truncate">{pr.associateName}</div>
                </div>
              ),
            },
            {
              key: 'employment',
              header: 'Employment',
              sortable: true,
              cardMeta: true,
              accessor: (pr) => (pr.workStatus ? workStatusEnglish(pr.workStatus) : 'No longer on file'),
              cell: (pr) => (pr.workStatus ? <PeopleStatusBadge status={pr.workStatus} size="sm" /> : <span className="text-xs text-silver/60">No longer on file</span>),
            },
            { key: 'country', header: 'Country', accessor: (pr) => pr.country, sortable: true, className: 'text-silver', hideBelow: 1180 },
            { key: 'ds2019', header: 'DS-2019', accessor: (pr) => pr.ds2019Number, sortable: true, className: 'text-silver', hideBelow: 1280 },
            { key: 'sponsor', header: 'Sponsor', accessor: (pr) => pr.sponsorAgency, sortable: true, className: 'text-silver', hideBelow: 1180 },
            {
              key: 'program',
              header: 'Program',
              accessor: (pr) => pr.programEndDate,
              csv: (pr) => `${pr.programStartDate} → ${pr.programEndDate}`,
              sortable: true,
              searchable: false,
              cardMeta: true,
              className: 'text-silver tabular-nums',
              cell: (pr) => (
                <>
                  {fmtDate(parseYmd(pr.programStartDate))} → {fmtDate(parseYmd(pr.programEndDate))}
                </>
              ),
            },
            {
              key: 'daysLeft',
              header: 'Days left',
              accessor: (pr) => pr.daysUntilEnd,
              csv: (pr) => daysLeftWords(pr.daysUntilEnd),
              sortable: true,
              searchable: false,
              cell: (pr) => (
                <Badge variant={expiryVariant(pr.daysUntilEnd)}>
                  <span className="tabular-nums">{daysLeftWords(pr.daysUntilEnd)}</span>
                </Badge>
              ),
            },
            {
              key: 'nextShift',
              header: 'Next shift',
              accessor: (pr) => pr.nextShift?.startsAt ?? null,
              csv: (pr) => (pr.nextShift ? shiftWords(pr.nextShift) : ''),
              sortable: true,
              searchable: false,
              stopRowClick: true,
              cell: (pr) =>
                pr.nextShift ? (
                  <Link to={`/scheduling?shift=${pr.nextShift.id}`} className="text-xs text-silver hover:underline">
                    {fmtDateTz(pr.nextShift.startsAt, pr.nextShift.timezone)}
                  </Link>
                ) : (
                  <span className="text-xs text-silver/60">None</span>
                ),
            },
            {
              key: 'flags',
              header: 'After the end',
              accessor: (pr) => [pr.scheduledAfterEnd ? 'Scheduled after program end' : '', pr.workedAfterEndOn ? `Worked after program end (${pr.workedAfterEndOn})` : ''].filter(Boolean).join('; ') || null,
              sortable: true,
              searchable: false,
              cell: (pr) => (
                <div className="flex flex-wrap gap-1">
                  {pr.scheduledAfterEnd && (
                    <Badge variant="destructive" size="sm">
                      Scheduled after program end
                    </Badge>
                  )}
                  {pr.workedAfterEndOn && (
                    <Badge variant="destructive" size="sm">
                      Worked after program end
                    </Badge>
                  )}
                  {!pr.scheduledAfterEnd && !pr.workedAfterEndOn && <span className="text-xs text-silver/60">—</span>}
                </div>
              ),
            },
          ]}
        />
        </TableShell>
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-lg"
      >
        {drawerTarget && (
          <J1DetailPanel
            profile={drawerTarget}
            returnPath={returnPath}
            canManage={canManage}
            onEdit={openEditFromDrawer}
          />
        )}
      </Drawer>

      <UpsertJ1Dialog
        open={upsertSeed !== null}
        seed={upsertSeed}
        onOpenChange={(o) => !o && setUpsertSeed(null)}
        onSaved={() => {
          setUpsertSeed(null);
          refresh();
        }}
      />
    </section>
  );
}

function J1DetailPanel({
  profile,
  returnPath = null,
  canManage,
  onEdit,
}: {
  profile: J1Profile;
  /** Surface the reviewer deep-linked from (null = none). */
  returnPath?: string | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            src={personPhotoUrl({ photoUrl: profile.associatePhotoUrl, associateId: profile.associateId })}
            name={profile.associateName}
            email={profile.associateEmail}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{profile.associateName}</DrawerTitle>
            <DrawerDescription className="truncate">
              {profile.associateEmail}
            </DrawerDescription>
          </div>
          {returnPath && (
            <Link
              to={returnPath}
              className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
            >
              <ArrowLeft className="h-3 w-3" />
              Back
            </Link>
          )}
          <Link
            to={`/people?associateId=${profile.associateId}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-gold hover:underline"
          >
            View profile
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Badge variant={expiryVariant(profile.daysUntilEnd)}>
            <span className="tabular-nums">{daysLeftWords(profile.daysUntilEnd)}</span>
          </Badge>
          {profile.workStatus && <PeopleStatusBadge status={profile.workStatus} size="sm" />}
          <span className="text-xs text-silver">{profile.country}</span>
        </div>
        {(profile.scheduledAfterEnd || profile.workedAfterEndOn) && (
          <div className="mb-4 space-y-1 rounded-md border border-negative-200 bg-negative-100 p-3 text-xs text-negative-800" role="alert">
            {profile.scheduledAfterEnd && (
              <p>
                Scheduled after the program ends:{' '}
                <Link to={`/scheduling?shift=${profile.scheduledAfterEnd.id}`} className="underline">
                  {shiftWords(profile.scheduledAfterEnd)}
                </Link>
                . Move it to someone else.
              </p>
            )}
            {profile.workedAfterEndOn && <p>Clocked in on {fmtDate(profile.workedAfterEndOn)}, after the program ended.</p>}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Program start">
            {fmtDate(parseYmd(profile.programStartDate))}
          </DetailRow>
          <DetailRow label="Program end">
            {fmtDate(parseYmd(profile.programEndDate))}
            {profile.programEndSource === 'program' && <span className="block text-2xs text-silver/70">From the program record</span>}
          </DetailRow>
          <DetailRow label="Grace period ends">
            {profile.graceEndsOn ? fmtDate(parseYmd(profile.graceEndsOn)) : '—'}
            <span className="block text-2xs text-silver/70">May stay, may not work</span>
          </DetailRow>
          <DetailRow label="DS-2019 ends">{profile.ds2019ExpiresOn ? fmtDate(parseYmd(profile.ds2019ExpiresOn)) : '—'}</DetailRow>
          <DetailRow label="Next shift">
            {profile.nextShift ? (
              <Link to={`/scheduling?shift=${profile.nextShift.id}`} className="text-gold hover:underline">
                {shiftWords(profile.nextShift)}
              </Link>
            ) : (
              'None'
            )}
          </DetailRow>
          <DetailRow label="DS-2019 number">{profile.ds2019Number}</DetailRow>
          <DetailRow label="Sponsor agency">{profile.sponsorAgency}</DetailRow>
          <DetailRow label="Visa #">{profile.visaNumber ?? '—'}</DetailRow>
          <DetailRow label="SEVIS ID">{profile.sevisId ?? '—'}</DetailRow>
        </dl>
      </DrawerBody>
      {canManage && (
        <DrawerFooter>
          <Button variant="outline" onClick={onEdit}>
            Edit profile
          </Button>
        </DrawerFooter>
      )}
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 break-all">{children}</dd>
    </div>
  );
}

interface UpsertJ1DialogProps {
  open: boolean;
  seed: UpsertSeed | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function UpsertJ1Dialog({ open, seed, onOpenChange, onSaved }: UpsertJ1DialogProps) {
  const [associateId, setAssociateId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [ds2019, setDs2019] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [country, setCountry] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && seed) {
      setAssociateId(seed.associateId);
      setStart(seed.start);
      setEnd(seed.end);
      setDs2019(seed.ds2019);
      setSponsor(seed.sponsor);
      setCountry(seed.country);
      setError(null);
    }
  }, [open, seed]);

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

  const editing = !!seed?.associateId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Update J-1 profile' : 'Add J-1 profile'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Updating the existing profile for this associate. A later program end lets scheduling book them again.'
              : 'Upsert by associate ID — re-saving with the same ID updates the existing profile.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Associate ID" required>
              <Input
                required
                readOnly={editing}
                value={associateId}
                onChange={(e) => setAssociateId(e.target.value)}
                placeholder="00000000-0000-4000-8000-…"
              />
            </Field>
            <Field label="Country" required>
              <Input
                required
                value={country}
                onChange={(e) => setCountry(e.target.value)}
              />
            </Field>
            <Field label="Program start" required>
              <Input
                type="date"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Program end" required>
              <Input
                type="date"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
            <Field label="DS-2019 number" required>
              <Input
                required
                value={ds2019}
                onChange={(e) => setDs2019(e.target.value)}
              />
            </Field>
            <Field label="Sponsor agency" required>
              <Input
                required
                value={sponsor}
                onChange={(e) => setSponsor(e.target.value)}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
