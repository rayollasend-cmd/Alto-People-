import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, CalendarPlus, ChevronDown, FileText, Mail, MoreHorizontal, Pencil } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { ClientSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { archiveClient, upsertClientStatement } from '@/lib/clientsApi';
import { useConfirm } from '@/lib/confirm';
import { fmtMonthYearTz } from '@/lib/format';
import { useMinWidth } from '@/lib/useViewport';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

/**
 * The client record's header actions: Edit (opens Basics in its form),
 * Post open shifts (the scheduler's new-shift dialog, on this client), New
 * statement (payroll), Email primary contact, and Archive behind "More"
 * and a confirm. On a phone they collapse into one Actions menu.
 */

export function ClientRecordActions({
  client,
  primaryEmail,
  onEdit,
  onOpenTab,
}: {
  client: ClientSummary;
  /** The primary contact's email, when there is one. */
  primaryEmail: { name: string; email: string } | null;
  onEdit: () => void;
  onOpenTab: (key: string) => void;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const wide = useMinWidth(640);
  const [statementOpen, setStatementOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const canManage = can('manage:clients');
  const canSchedule = can('manage:scheduling');
  const canBill = can('process:payroll');
  const shiftsTo = `/scheduling?client=${client.id}&new=shift`;
  const mailto = primaryEmail ? `mailto:${primaryEmail.email}` : null;

  const onArchive = async () => {
    if (
      !(await confirm({
        title: `Archive "${client.name}"?`,
        description: "They'll be hidden from the clients list. Open applications, payroll and associates aren't deleted.",
        confirmLabel: 'Archive',
        destructive: true,
      }))
    ) {
      return;
    }
    setArchiving(true);
    try {
      await archiveClient(client.id);
      toast.success(`"${client.name}" archived.`);
      navigate('/clients');
    } catch (err) {
      toast.error('Could not archive.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
      setArchiving(false);
    }
  };

  const dialog = statementOpen && <NewStatementDialog clientId={client.id} onClose={() => setStatementOpen(false)} onCreated={() => onOpenTab('statements')} />;
  const anything = canManage || canSchedule || canBill || mailto;
  if (!anything) return null;

  if (!wide) {
    return (
      <div className="flex items-center gap-2" data-testid="client-record-actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="client-actions-menu">
              Actions
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            {canManage && <DropdownMenuItem onSelect={onEdit}>Edit basics</DropdownMenuItem>}
            {canSchedule && <DropdownMenuItem onSelect={() => navigate(shiftsTo)}>Post open shifts</DropdownMenuItem>}
            {canBill && <DropdownMenuItem onSelect={() => setStatementOpen(true)}>New statement</DropdownMenuItem>}
            {mailto && (
              <DropdownMenuItem asChild>
                <a href={mailto}>Email {primaryEmail!.name}</a>
              </DropdownMenuItem>
            )}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive disabled={archiving} onSelect={() => void onArchive()}>
                  Archive client
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {dialog}
      </div>
    );
  }

  // ONE primary — the account's main job for this reader (staff the shifts,
  // else bill them, else keep the record) — and everything else in More
  // (F500 2026-10-26: four equal outline buttons and no primary).
  const primary: 'shifts' | 'statement' | 'edit' | null = canSchedule ? 'shifts' : canBill ? 'statement' : canManage ? 'edit' : null;
  const more = (canManage && primary !== 'edit') || (canBill && primary !== 'statement') || !!mailto || canManage;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="client-record-actions">
      {primary === 'shifts' && (
        <Button asChild size="sm">
          <Link to={shiftsTo}>
            <CalendarPlus className="h-3.5 w-3.5" />
            Post open shifts
          </Link>
        </Button>
      )}
      {primary === 'statement' && (
        <Button size="sm" onClick={() => setStatementOpen(true)}>
          <FileText className="h-3.5 w-3.5" />
          New statement
        </Button>
      )}
      {primary === 'edit' && (
        <Button size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      )}
      {more && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label="More actions" data-testid="client-actions-more">
              <MoreHorizontal className="h-3.5 w-3.5" />
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            {canManage && primary !== 'edit' && (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit basics
              </DropdownMenuItem>
            )}
            {canBill && primary !== 'statement' && (
              <DropdownMenuItem onSelect={() => setStatementOpen(true)}>
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                New statement
              </DropdownMenuItem>
            )}
            {mailto && (
              <DropdownMenuItem asChild>
                <a href={mailto} title={primaryEmail!.email}>
                  <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                  Email {primaryEmail!.name}
                </a>
              </DropdownMenuItem>
            )}
            {canManage && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive disabled={archiving} onSelect={() => void onArchive()}>
                  <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                  Archive client
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {dialog}
    </div>
  );
}

/** The last 12 calendar months as statement periods, newest first. */
function monthOptions(now = new Date()) {
  return Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 0));
    return { key: start.toISOString().slice(0, 7), label: fmtMonthYearTz(start, 'UTC'), start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  });
}

/** The Statements tab's own flow: draft (or refresh) a month's statement for this client. */
function NewStatementDialog({ clientId, onClose, onCreated }: { clientId: string; onClose: () => void; onCreated: () => void }) {
  const queryClient = useQueryClient();
  const months = useMemo(() => monthOptions(), []);
  const [key, setKey] = useState(months[1]?.key ?? months[0]!.key);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const m = months.find((x) => x.key === key)!;
    setBusy(true);
    try {
      await upsertClientStatement(clientId, m.start, m.end);
      await queryClient.invalidateQueries({ queryKey: ['clients', clientId, 'statements'] });
      toast.success(`The ${m.label} statement is drafted. Review it, then finalize.`);
      onClose();
      onCreated();
    } catch (err) {
      toast.error('Could not draft the statement.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New statement</DialogTitle>
          <DialogDescription>Drafts the month from approved time. A draft already there for the month is refreshed; a finalized one never changes.</DialogDescription>
        </DialogHeader>
        <Field label="Month">
          {(p) => (
            <Select value={key} onChange={(e) => setKey(e.target.value)} {...p}>
              {months.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void create()} loading={busy}>
            Draft statement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
