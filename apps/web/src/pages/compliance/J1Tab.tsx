import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Globe, Plane, Plus } from 'lucide-react';
import { DirectorateHeader, Kpi, KpiStrip, TableShell } from './DirectorateShell';
import { sanitizeReturnPath } from './section2Verification';
import type { J1Profile } from '@alto-people/shared';
import { listJ1Profiles, upsertJ1 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDate, parseYmd } from '@/lib/format';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

function expiryVariant(days: number): 'destructive' | 'pending' | 'default' {
  if (days < 0) return 'destructive';
  if (days < 30) return 'pending';
  return 'default';
}

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
  // ?associateId= deep-links one participant (the scorecard's Fix links and
  // the application checklist send it) — auto-open their drawer once the
  // list arrives. ?return= is the surface the reviewer came from; the
  // drawer offers a way back. Both are captured into state once, then
  // consumed (replace: true): ComplianceHome tab switches copy the current
  // search params, so lingering params would re-arm on every tab visit.
  const [deepLinkParams, setDeepLinkParams] = useSearchParams();
  const [deepLinkAssociateId] = useState<string | null>(() =>
    deepLinkParams.get('associateId'),
  );
  const [returnPath] = useState<string | null>(() =>
    sanitizeReturnPath(deepLinkParams.get('return')),
  );
  const deepLinkOpened = useRef(false);
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    if (!deepLinkParams.has('associateId') && !deepLinkParams.has('return')) return;
    deepLinkConsumed.current = true;
    const params = new URLSearchParams(deepLinkParams);
    params.delete('associateId');
    params.delete('return');
    setDeepLinkParams(params, { replace: true });
  }, [deepLinkParams, setDeepLinkParams]);
  const [profiles, setProfiles] = useState<J1Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<J1Profile | null>(null);
  const [upsertSeed, setUpsertSeed] = useState<UpsertSeed | null>(null);

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

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listJ1Profiles();
      setProfiles(res.profiles);
      setDrawerTarget((prev) =>
        prev ? res.profiles.find((p) => p.associateId === prev.associateId) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  return (
    <section>
      <DirectorateHeader
        icon={Plane}
        title="J-1 program"
        blurb="Exchange-visitor participants — DS-2019, sponsor, and program window tracking"
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
          <Kpi label="Participants" value={profiles.length} />
          <Kpi
            label="Active"
            value={profiles.filter((p) => p.daysUntilEnd >= 0).length}
            tone="text-success"
          />
          <Kpi
            label="Ending ≤ 30d"
            value={profiles.filter((p) => p.daysUntilEnd >= 0 && p.daysUntilEnd <= 30).length}
            tone={
              profiles.some((p) => p.daysUntilEnd >= 0 && p.daysUntilEnd <= 30)
                ? 'text-warning'
                : undefined
            }
          />
          <Kpi
            label="Program ended"
            value={profiles.filter((p) => p.daysUntilEnd < 0).length}
            tone={profiles.some((p) => p.daysUntilEnd < 0) ? 'text-alert' : undefined}
          />
        </KpiStrip>
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
          title="No J-1 profiles yet"
          description={
            canManage
              ? 'Add a J-1 profile for an associate when their DS-2019 paperwork is in hand.'
              : 'J-1 profiles will appear here once they are created.'
          }
          action={
            canManage ? (
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden sm:table-cell">Country</TableHead>
              <TableHead className="hidden lg:table-cell">DS-2019</TableHead>
              <TableHead className="hidden lg:table-cell">Sponsor</TableHead>
              <TableHead className="hidden md:table-cell">Program</TableHead>
              <TableHead>Days left</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles.map((p) => (
              <TableRow
                key={p.id}
                className="group cursor-pointer"
                onClick={(ev) => {
                  const target = ev.target as HTMLElement;
                  if (target.closest('button, a, input, [data-no-row-click]')) return;
                  if (window.getSelection()?.toString()) return;
                  setDrawerTarget(p);
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={p.associateName} email={p.associateEmail} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate">{p.associateName}</div>
                      {/* Phone-only secondary line so the country / program
                          dates aren't lost when their columns are hidden. */}
                      <div className="sm:hidden text-xs2 text-silver/70 truncate">
                        {p.country}
                      </div>
                      <div className="md:hidden text-2xs text-silver/70 tabular-nums">
                        {fmtDate(parseYmd(p.programStartDate))} →{' '}
                        {fmtDate(parseYmd(p.programEndDate))}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-silver">{p.country}</TableCell>
                <TableCell className="hidden lg:table-cell text-silver">{p.ds2019Number}</TableCell>
                <TableCell className="hidden lg:table-cell text-silver">{p.sponsorAgency}</TableCell>
                <TableCell className="hidden md:table-cell text-silver tabular-nums">
                  {fmtDate(parseYmd(p.programStartDate))} →{' '}
                  {fmtDate(parseYmd(p.programEndDate))}
                </TableCell>
                <TableCell>
                  <Badge variant={expiryVariant(p.daysUntilEnd)}>
                    <span className={cn('tabular-nums')}>{p.daysUntilEnd}d</span>
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
        <div className="flex items-center gap-3 mb-5">
          <Badge variant={expiryVariant(profile.daysUntilEnd)}>
            <span className="tabular-nums">{profile.daysUntilEnd}d remaining</span>
          </Badge>
          <span className="text-xs text-silver">{profile.country}</span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Program start">
            {fmtDate(parseYmd(profile.programStartDate))}
          </DetailRow>
          <DetailRow label="Program end">
            {fmtDate(parseYmd(profile.programEndDate))}
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
              ? 'Updating the existing profile for this associate.'
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
