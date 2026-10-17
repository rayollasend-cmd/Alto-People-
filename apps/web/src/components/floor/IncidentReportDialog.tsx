import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { reportIncident, type IncidentSeverity } from '@/lib/floorApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { cn } from '@/lib/cn';

/**
 * File an incident from the floor — the supervisor's phone, the moment it
 * happens: what, where, who, how bad, and the photo. It lands in the OSHA
 * log for HR (report:incident, no manage:compliance), and HR hears at once.
 * A near miss — nobody hurt — is kept in the log and never recorded.
 */

const SEVERITIES: Array<{ value: IncidentSeverity; label: string; hint: string }> = [
  { value: 'FIRST_AID', label: 'First aid only', hint: 'A bandage, an ice pack — back to work.' },
  { value: 'MEDICAL_TREATMENT', label: 'Needed a doctor', hint: 'Urgent care, a clinic, the ER.' },
  { value: 'RESTRICTED_DUTY', label: 'Can’t do their usual job', hint: 'Working, but on lighter duty.' },
  { value: 'DAYS_AWAY', label: 'Sent home / days away', hint: 'Could not keep working.' },
];

export function IncidentReportDialog({
  open,
  onOpenChange,
  presetAssociate = null,
  onFiled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presetAssociate?: PickedAssociate | null;
  onFiled?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [nearMiss, setNearMiss] = useState(false);
  const [severity, setSeverity] = useState<IncidentSeverity>('FIRST_AID');
  const [who, setWho] = useState<PickedAssociate | null>(presetAssociate);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setDescription('');
    setLocation('');
    setNearMiss(false);
    setSeverity('FIRST_AID');
    setWho(presetAssociate);
    setPhoto(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
  };

  const pick = (f: File | null) => {
    if (preview) URL.revokeObjectURL(preview);
    setPhoto(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  };

  const submit = async () => {
    if (description.trim().length < 5) {
      toast.error('Say what happened — a sentence is enough.');
      return;
    }
    setBusy(true);
    try {
      const r = await reportIncident({
        description: description.trim(),
        severity,
        nearMiss,
        location: location.trim() || undefined,
        associateId: nearMiss ? null : who?.id ?? null,
        photo,
      });
      toast.success(nearMiss ? 'Hazard reported. HR has it.' : 'Incident filed. HR has it.');
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      onFiled?.(r.id);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not file the incident.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)} confirmDiscard={() => description.trim().length > 0 || !!photo}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning" aria-hidden="true" />
            Report an incident
          </DialogTitle>
          <DialogDescription>Goes to HR’s safety log the moment you send it. Write it the way you’d say it.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What kind">
            <button
              type="button"
              role="radio"
              aria-checked={!nearMiss}
              onClick={() => setNearMiss(false)}
              className={cn('rounded-md border px-3 py-2.5 text-left text-sm coarse:min-h-11', !nearMiss ? 'border-gold bg-gold/[0.08] text-ink' : 'border-navy-secondary text-silver')}
            >
              Someone was hurt
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={nearMiss}
              onClick={() => setNearMiss(true)}
              className={cn('rounded-md border px-3 py-2.5 text-left text-sm coarse:min-h-11', nearMiss ? 'border-gold bg-gold/[0.08] text-ink' : 'border-navy-secondary text-silver')}
            >
              Hazard / near miss
            </button>
          </div>

          {!nearMiss && (
            <>
              <Field label="Who">
                {(p) => <AssociatePicker id={p.id} value={who} onChange={setWho} placeholder="Search your crew" />}
              </Field>
              <Field label="How bad" hint={SEVERITIES.find((s) => s.value === severity)?.hint}>
                {(p) => (
                  <Select {...p} value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}>
                    {SEVERITIES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </>
          )}

          <Field label="What happened" required>
            {(p) => (
              <Textarea
                {...p}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder={nearMiss ? 'Wet floor by dock 3, no sign out.' : 'Slipped on the dock, landed on the right wrist.'}
                autoFocus
              />
            )}
          </Field>
          <Field label="Where in the building">
            {(p) => <Input {...p} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} placeholder="Receiving dock, aisle 12…" />}
          </Field>

          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              capture="environment"
              className="sr-only"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
              aria-label="Add a photo"
            />
            {preview ? (
              <div className="relative inline-block">
                <img src={preview} alt="What you captured at the scene" className="max-h-40 rounded-md border border-navy-secondary" />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="secondary"
                  className="absolute -right-2 -top-2"
                  aria-label="Remove the photo"
                  onClick={() => {
                    pick(null);
                    if (fileRef.current) fileRef.current.value = '';
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                <Camera className="mr-2 h-4 w-4" aria-hidden="true" />
                Add a photo
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={busy || description.trim().length < 5}>
            {nearMiss ? 'Report hazard' : 'File incident'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
