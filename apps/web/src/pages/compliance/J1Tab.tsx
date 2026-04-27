import { useCallback, useEffect, useState } from 'react';
import { Globe, Plus } from 'lucide-react';
import type { J1Profile } from '@alto-people/shared';
import { listJ1Profiles, upsertJ1 } from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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

export function J1Tab({ canManage }: { canManage: boolean }) {
  const [profiles, setProfiles] = useState<J1Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUpsert, setShowUpsert] = useState(false);

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
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">J-1 program profiles</h2>
        {canManage && (
          <Button onClick={() => setShowUpsert(true)} size="sm">
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
              <Button onClick={() => setShowUpsert(true)} size="sm">
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
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.associateName}</TableCell>
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

      <UpsertJ1Dialog
        open={showUpsert}
        onOpenChange={setShowUpsert}
        onSaved={() => {
          setShowUpsert(false);
          refresh();
        }}
      />
    </section>
  );
}

interface UpsertJ1DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function UpsertJ1Dialog({ open, onOpenChange, onSaved }: UpsertJ1DialogProps) {
  const [associateId, setAssociateId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [ds2019, setDs2019] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [country, setCountry] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAssociateId('');
      setStart('');
      setEnd('');
      setDs2019('');
      setSponsor('');
      setCountry('');
      setError(null);
    }
  }, [open]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>J-1 profile</DialogTitle>
          <DialogDescription>
            Upsert by associate ID — re-saving with the same ID updates the
            existing profile.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Associate ID" required>
              <Input
                required
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
