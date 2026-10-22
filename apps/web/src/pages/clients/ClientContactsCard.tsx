import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, MoreHorizontal, Phone, Plus, Star, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  CLIENT_CONTACT_ROLE_LABELS,
  ClientContactRoleSchema,
  type ClientContact,
  type ClientContactRole,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  clientOverviewKey,
  createClientContact,
  deleteClientContact,
  updateClientContact,
} from '@/lib/clientAccountApi';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';

/**
 * The people at the client the account is run with: who decides, who pays
 * the statements, who runs the floor. One is the primary; email and phone
 * are one tap away. Managers (manage:clients) add, edit, mark primary and
 * remove; everyone who can open the client reads.
 */

const ROLES = ClientContactRoleSchema.options;

/** An address that may wrap after the "@" (never mid-word unless it must). */
function EmailText({ email }: { email: string }) {
  const at = email.indexOf('@');
  if (at < 0) return <span className="[overflow-wrap:anywhere]">{email}</span>;
  return (
    <span className="min-w-0 [overflow-wrap:anywhere]">
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </span>
  );
}
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

interface Draft {
  name: string;
  title: string;
  role: ClientContactRole;
  email: string;
  phone: string;
  notes: string;
  isPrimary: boolean;
}

const emptyDraft = (first: boolean): Draft => ({ name: '', title: '', role: 'PRIMARY', email: '', phone: '', notes: '', isPrimary: first });
const draftOf = (c: ClientContact): Draft => ({ name: c.name, title: c.title ?? '', role: c.role, email: c.email ?? '', phone: c.phone ?? '', notes: c.notes ?? '', isPrimary: c.isPrimary });

export function ClientContactsCard({
  clientId,
  clientName,
  contacts,
  canManage,
}: {
  clientId: string;
  clientName: string;
  contacts: ClientContact[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ClientContact | 'new' | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: clientOverviewKey(clientId) });

  const makePrimary = async (c: ClientContact) => {
    try {
      await updateClientContact(clientId, c.id, { isPrimary: true });
      toast.success(`${c.name} is the primary contact.`);
      await refresh();
    } catch (err) {
      toast.error('Could not change the primary contact.', { description: err instanceof ApiError ? err.message : undefined });
    }
  };

  const remove = async (c: ClientContact) => {
    if (
      !(await confirm({
        title: `Remove ${c.name}?`,
        description: c.isPrimary ? `They are the primary contact; ${clientName} will have none until you name another.` : 'They come off this account’s contacts.',
        confirmLabel: 'Remove',
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await deleteClientContact(clientId, c.id);
      toast.success(`${c.name} removed.`);
      await refresh();
    } catch (err) {
      toast.error('Could not remove the contact.', { description: err instanceof ApiError ? err.message : undefined });
    }
  };

  return (
    <Card id="contacts" className="scroll-mt-24">
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          as="h3"
          icon={Users}
          title={`Contacts${contacts.length ? ` (${contacts.length})` : ''}`}
          trailing={
            canManage && contacts.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            ) : undefined
          }
        />
        {contacts.length === 0 ? (
          <EmptyState
            size="sm"
            title="No contacts on file."
            description={`Add the people you work with at ${clientName}: who decides, who pays, who runs the site.`}
            action={
              canManage ? (
                <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
                  <Plus className="h-3.5 w-3.5" />
                  Add a contact
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="client-contacts">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <Avatar name={c.name} email={c.email} size="sm" className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-ink">{c.name}</span>
                    {c.isPrimary && (
                      <Badge variant="accent" size="sm">
                        Primary
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted">{[c.title, CLIENT_CONTACT_ROLE_LABELS[c.role]].filter(Boolean).join(' · ')}</p>
                  {(c.email || c.phone) && (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      {c.email && (
                        <a href={`mailto:${c.email}`} className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-accent hover:underline">
                          <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <EmailText email={c.email} />
                        </a>
                      )}
                      {c.phone && (
                        <a href={telHref(c.phone)} className="inline-flex items-center gap-1.5 whitespace-nowrap text-accent hover:underline">
                          <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {c.phone}
                        </a>
                      )}
                    </div>
                  )}
                  {c.notes && <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{c.notes}</p>}
                </div>
                {canManage && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`} className="shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(c)}>Edit</DropdownMenuItem>
                      {!c.isPrimary && (
                        <DropdownMenuItem onSelect={() => void makePrimary(c)}>
                          <Star className="h-3.5 w-3.5" aria-hidden="true" />
                          Make primary
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => void remove(c)}>
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <ContactDialog
          clientId={clientId}
          contact={editing === 'new' ? null : editing}
          first={contacts.length === 0}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </Card>
  );
}

function ContactDialog({
  clientId,
  contact,
  first,
  onClose,
  onSaved,
}: {
  clientId: string;
  contact: ClientContact | null;
  first: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = contact ? draftOf(contact) : emptyDraft(first);
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const dirty = (Object.keys(d) as Array<keyof Draft>).some((k) => d[k] !== initial[k]);

  const save = async () => {
    if (!d.name.trim()) {
      toast.error('A contact needs a name.');
      return;
    }
    setSaving(true);
    const body = {
      name: d.name.trim(),
      title: d.title.trim() || null,
      role: d.role,
      email: d.email.trim() || null,
      phone: d.phone.trim() || null,
      notes: d.notes.trim() || null,
      isPrimary: d.isPrimary,
    };
    try {
      if (contact) await updateClientContact(clientId, contact.id, body);
      else await createClientContact(clientId, body);
      toast.success(contact ? 'Contact saved.' : `${body.name} added.`);
      onSaved();
    } catch (err) {
      toast.error('Could not save the contact.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contact ? `Edit ${contact.name}` : 'Add a contact'}</DialogTitle>
          <DialogDescription>Someone at the client you work with. Email and phone become one-tap links.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              {(p) => <Input value={d.name} onChange={(e) => set('name', e.target.value)} maxLength={120} autoFocus {...p} />}
            </Field>
            <Field label="Title">
              {(p) => <Input value={d.title} onChange={(e) => set('title', e.target.value)} maxLength={120} placeholder="General manager" {...p} />}
            </Field>
            <Field label="Role on the account">
              {(p) => (
                <Select value={d.role} onChange={(e) => set('role', e.target.value as ClientContactRole)} {...p}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {CLIENT_CONTACT_ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Email">
              {(p) => <Input type="email" value={d.email} onChange={(e) => set('email', e.target.value)} maxLength={254} {...p} />}
            </Field>
            <Field label="Phone">
              {(p) => <Input type="tel" inputMode="tel" value={d.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} {...p} />}
            </Field>
          </div>
          <Field label="Notes" hint="Anything the next person should know: best time to call, who signs off.">
            {(p) => <Textarea value={d.notes} onChange={(e) => set('notes', e.target.value)} maxLength={1000} rows={3} {...p} />}
          </Field>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={d.isPrimary} onChange={(e) => set('isPrimary', e.target.checked)} className="rounded border-line" />
            Primary contact for this client
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!dirty}>
              {contact ? 'Save' : 'Add contact'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
