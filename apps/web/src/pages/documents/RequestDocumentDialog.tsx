import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { DocumentKind } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { DOCUMENT_KIND_LABEL, kindOffered, requestDocument } from '@/lib/documentsApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';

/** The kinds a person uploads themselves (results and generated PDFs come from elsewhere). */
const REQUESTABLE: DocumentKind[] = ['ID', 'SSN_CARD', 'I9_SUPPORTING', 'J1_DS2019', 'J1_VISA', 'HOUSING_AGREEMENT', 'TRANSPORT_AGREEMENT', 'OTHER'];

/**
 * Ask someone for a document they haven't uploaded (F500 G1: the vault had
 * no primary action). The person gets a notice that opens their documents
 * page with the kind already chosen; their upload lands in this vault.
 */
export function RequestDocumentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { moduleOn } = useTenant();
  const kinds = useMemo(() => REQUESTABLE.filter((k) => kindOffered(k, moduleOn)), [moduleOn]);
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<DocumentKind>('ID');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => {
    onOpenChange(false);
    setPerson(null);
    setNote('');
  };
  const send = async () => {
    if (!person) return;
    setBusy(true);
    try {
      await requestDocument({ associateId: person.id, kind, note: note.trim() || null });
      toast.success(`Asked ${person.name} for their ${(DOCUMENT_KIND_LABEL[kind] ?? kind).toLowerCase()}.`);
      close();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a document</DialogTitle>
          <DialogDescription>They get a notice that opens their documents page with this kind chosen. The upload lands here for review.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Person">
            <AssociatePicker value={person} onChange={setPerson} placeholder="Find someone by name…" />
          </Field>
          <Field label="Document">
            <Select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {DOCUMENT_KIND_LABEL[k] ?? k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Note (optional)">
            <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you need it, or by when." />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void send()} loading={busy} disabled={!person || busy}>
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
