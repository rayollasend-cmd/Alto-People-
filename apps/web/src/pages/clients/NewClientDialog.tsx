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
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

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
      toast.error('Name is required.');
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
          <div>
            <Label htmlFor="nc-name" required>
              Name
            </Label>
            <Input
              id="nc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="nc-industry">Industry</Label>
            <Input
              id="nc-industry"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              maxLength={80}
              placeholder="e.g. Hospitality, Logistics"
            />
          </div>
          <div>
            <Label htmlFor="nc-status">Status</Label>
            <select
              id="nc-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ClientStatus)}
              aria-describedby="nc-status-help"
              className="mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <FormHint id="nc-status-help">
              PROSPECT is hidden from active-roster counts in dashboards.
            </FormHint>
          </div>
          <div>
            <Label htmlFor="nc-email">Contact email</Label>
            <Input
              id="nc-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              maxLength={254}
              placeholder="ops@example.com"
            />
          </div>
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
