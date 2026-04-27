import { useCallback, useEffect, useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import type { J1Profile } from '@alto-people/shared';
import { listJ1Profiles, upsertJ1 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
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
  const [profiles, setProfiles] = useState<J1Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<J1Profile | null>(null);
  const [upsertSeed, setUpsertSeed] = useState<UpsertSeed | null>(null);

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
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">J-1 program profiles</h2>
        {canManage && (
          <Button onClick={() => setUpsertSeed(EMPTY_SEED)} size="sm">
            <Plus className="h-4 w-4" />
            Add / update profile
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!profiles && <SkeletonRows count={4} rowHeight="h-12" />}
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>DS-2019</TableHead>
              <TableHead>Sponsor</TableHead>
              <TableHead>Program</TableHead>
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
                    <span>{p.associateName}</span>
                  </div>
                </TableCell>
                <TableCell className="text-silver">{p.country}</TableCell>
                <TableCell className="text-silver">{p.ds2019Number}</TableCell>
                <TableCell className="text-silver">{p.sponsorAgency}</TableCell>
                <TableCell className="text-silver tabular-nums">
                  {p.programStartDate} → {p.programEndDate}
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
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-lg"
      >
        {drawerTarget && (
          <J1DetailPanel
            profile={drawerTarget}
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
  canManage,
  onEdit,
}: {
  profile: J1Profile;
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
          <DetailRow label="Program start">{profile.programStartDate}</DetailRow>
          <DetailRow label="Program end">{profile.programEndDate}</DetailRow>
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
      <dt className="text-[10px] uppercase tracking-widest text-silver/80">{label}</dt>
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

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-silver mb-1">
        {label}
        {required && <span className="text-alert"> *</span>}
      </span>
      {children}
    </label>
  );
}
