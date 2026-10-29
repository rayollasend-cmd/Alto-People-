import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CameraOff } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { endPersonPunchPhoto, getPersonPunchPhoto, punchPhotoUrl, setPersonPunchPhoto, type PersonPunchPhoto } from '@/lib/punchPhotosApi';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';

/**
 * Photo at punch, for one person (their record's Time tab): whether the
 * kiosk must photograph them, which rule says so and why, and — for whoever
 * manages time, or their supervisor — require it (with a reason and an end
 * date), end it early, or exempt them from their location's rule. Their
 * recent punch photos open on request: each view is on the audit log.
 */

const day = (ymd: string) => fmtDate(parseYmd(ymd) ?? ymd);
const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymdLocal(d);
};

export function PunchPhotoCard({ associateId }: { associateId: string }) {
  const { can } = useAuth();
  const allowed = can('manage:time') || can('manage:team-time');
  const qc = useQueryClient();
  const prompt = usePrompt();
  const key = ['punchPhoto', associateId];
  const q = useQuery({ queryKey: key, queryFn: () => getPersonPunchPhoto(associateId), enabled: allowed, retry: false });
  const [dialog, setDialog] = useState<null | 'require' | 'exempt'>(null);
  const [showPhotos, setShowPhotos] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const end = useMutation({
    mutationFn: (reason: string) => endPersonPunchPhoto(associateId, reason),
    onSuccess: () => {
      toast.success('Ended. Their location’s usual rule applies again.');
      refresh();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not end it.'),
  });

  if (!allowed) return null;
  if (q.isPending) return <Skeleton className="h-28" />;
  if (q.isError) return null; // out of reach (404) or not available here — say nothing
  const p = q.data;
  const own = p.ownRule;

  const onEnd = async () => {
    const reason = await prompt({ title: `End ${p.name}’s photo rule?`, description: 'Their location’s (or the company’s) rule applies again, and they’re told.', reasonLabel: 'Why', reasonPlaceholder: 'Reviewed — no further issues', confirmLabel: 'End it' });
    if (reason) end.mutate(reason);
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <SectionTitle
          as="h3"
          title="Photo at punch"
          description={summary(p)}
          trailing={
            <Badge variant={p.required ? 'accent' : 'outline'} size="sm">
              {p.required ? (
                <>
                  <Camera className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Required
                </>
              ) : (
                <>
                  <CameraOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Not required
                </>
              )}
            </Badge>
          }
        />
        {own?.required && own.reason && (
          <p className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink">
            <span className="text-ink-muted">Why: </span>
            {own.reason}
          </p>
        )}
        {(p.last30Days.keptWithoutPhoto > 0 || p.last30Days.refusedWithoutPhoto > 0) && (
          <p className="text-sm text-ink-muted">
            Last 30 days: {p.last30Days.keptWithoutPhoto} {p.last30Days.keptWithoutPhoto === 1 ? 'punch' : 'punches'} kept without a photo for a supervisor to confirm,{' '}
            {p.last30Days.refusedWithoutPhoto} refused for having none.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {own ? (
            <Button size="sm" variant="secondary" onClick={() => void onEnd()} loading={end.isPending}>
              {own.required ? 'End early' : 'Remove the exemption'}
            </Button>
          ) : p.required ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog('exempt')}>
              Exempt them
            </Button>
          ) : (
            // A rule, not the tab's main action: secondary, so it doesn't lead the hours (PEOPLE-30).
            <Button size="sm" variant="secondary" onClick={() => setDialog('require')}>
              <Camera className="h-4 w-4" aria-hidden="true" /> Require a photo
            </Button>
          )}
          {p.recentPunches.some((r) => r.hasPhoto) && can('manage:time') && (
            <Button size="sm" variant="ghost" onClick={() => setShowPhotos((v) => !v)} aria-expanded={showPhotos}>
              {showPhotos ? 'Hide their punch photos' : 'Show their recent punch photos'}
            </Button>
          )}
        </div>
        {showPhotos && (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Recent punch photos">
            {p.recentPunches.map((r) => (
              <li key={r.id} className={cn('overflow-hidden rounded-md border', r.flagged ? 'border-warning/60' : 'border-line')}>
                {r.hasPhoto ? (
                  <img src={punchPhotoUrl(r.id)} alt={`${p.name}, ${r.action.toLowerCase().replace(/_/g, ' ')} ${fmtDateTime(r.at)}`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center bg-surface-raised text-xs text-ink-muted">No photo</div>
                )}
                <p className="truncate px-1.5 py-1 text-2xs text-ink-muted">{fmtDateTime(r.at)}</p>
              </li>
            ))}
          </ul>
        )}
        {showPhotos && <p className="text-2xs text-ink-muted">Each photo you open is recorded on the audit log.</p>}
      </CardContent>
      <RuleDialog
        mode={dialog}
        person={p}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          refresh();
        }}
      />
    </Card>
  );
}

function summary(p: PersonPunchPhoto): string {
  const r = p.decidedBy;
  if (!r) return 'The kiosk doesn’t require a photo — there’s no rule for them, their location or the company.';
  const by = r.setBy ? ` — set by ${r.setBy} on ${fmtDate(new Date(r.setAt))}` : '';
  const until = r.endsOn ? `, through ${day(r.endsOn)}` : '';
  if (r.scope === 'ASSOCIATE') return r.required ? `Required for them${until}${by}. They were told; they aren’t told why.` : `Exempt from their location’s rule${until}${by}.`;
  if (r.scope === 'SITE') return `${r.required ? 'Required' : 'Not required'} at ${r.siteName ?? 'their location'}, where they work${by}.`;
  if (r.scope === 'CLIENT') return `${r.required ? 'Required' : 'Not required'} at every ${r.clientName ?? 'client'} location${by}.`;
  return `${r.required ? 'Required' : 'Not required'} company-wide${by}.`;
}

function RuleDialog({ mode, person, onClose, onSaved }: { mode: null | 'require' | 'exempt'; person: PersonPunchPhoto; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [endsOn, setEndsOn] = useState(addDays(30));
  const [noEnd, setNoEnd] = useState(false);
  const save = useMutation({
    mutationFn: () => setPersonPunchPhoto(person.associateId, { required: mode === 'require', reason: reason.trim(), endsOn: noEnd ? null : endsOn }),
    onSuccess: () => {
      toast.success(mode === 'require' ? `A photo is now required at ${person.name}’s punches. They were told.` : `${person.name} is exempt from the location’s photo rule.`);
      setReason('');
      onSaved();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  const ready = reason.trim().length >= 5 && (noEnd || endsOn >= ymdLocal());
  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'require' ? `Require a photo at ${person.name}’s punches` : `Exempt ${person.name} from the photo rule`}</DialogTitle>
          <DialogDescription>
            {mode === 'require'
              ? 'The kiosk won’t let them skip the photo. If its camera is broken their punch still counts and goes to a supervisor to confirm. They’re told a photo is required — not why.'
              : 'Their punches won’t need a photo even though their location requires one.'}
          </DialogDescription>
        </DialogHeader>
        <Field label="Why" hint="It goes on the record. Apply it for a documented reason, the same way for everyone in the same situation.">
          {(f) => <Textarea rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={mode === 'require' ? 'Two punches last week that the supervisor didn’t see' : 'Medical accommodation on file'} {...f} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Through">{(f) => <Input type="date" min={ymdLocal()} value={endsOn} disabled={noEnd} onChange={(e) => setEndsOn(e.target.value)} {...f} />}</Field>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 accent-gold" checked={noEnd} onChange={(e) => setNoEnd(e.target.checked)} />
            No end date
          </label>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {[30, 60, 90].map((n) => (
            <button key={n} type="button" className="rounded-full border border-line px-2.5 py-1 text-ink-muted hover:text-ink" onClick={() => { setNoEnd(false); setEndsOn(addDays(n)); }}>
              {n} days
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!ready} loading={save.isPending}>
            {mode === 'require' ? 'Require it' : 'Exempt them'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
