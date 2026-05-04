import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientStatus, ClientSummary } from '@alto-people/shared';
import { createClient } from '@/lib/clientsApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

const STATUSES: ClientStatus[] = ['PROSPECT', 'ACTIVE', 'INACTIVE'];

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (c: ClientSummary) => void;
}

export function NewClientDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [status, setStatus] = useState<ClientStatus>('PROSPECT');
  const [contactEmail, setContactEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setIndustry('');
      setStatus('PROSPECT');
      setContactEmail('');
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      toast.error('Name required.');
      return;
    }
    setSubmitting(true);
    try {
      const created = await createClient({
        name: trimmed,
        industry: industry.trim() || null,
        status,
        contactEmail: contactEmail.trim() || null,
      });
      toast.success(`Client "${created.name}" created.`);
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not create client', {
        description: err instanceof ApiError ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>
            Defaults to PROSPECT — flip to ACTIVE once contracts are signed
            and you're ready for the live roster numbers to count.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name" required>
            {(p) => (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                autoFocus
                {...p}
              />
            )}
          </Field>
          <Field label="Industry">
            {(p) => (
              <Input
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                maxLength={80}
                placeholder="e.g. Hospitality, Logistics"
                {...p}
              />
            )}
          </Field>
          <Field
            label="Status"
            hint="PROSPECT is hidden from active-roster counts in dashboards."
          >
            {(p) => (
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as ClientStatus)}
                {...p}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Contact email">
            {(p) => (
              <Input
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                maxLength={254}
                placeholder="ops@example.com"
                {...p}
              />
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            <Plus className="h-4 w-4" />
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
