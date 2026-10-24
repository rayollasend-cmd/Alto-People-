import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookmarkPlus, Users } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { CostCenter, Department } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { listChannels } from '@/lib/communicationsApi';
import {
  broadcastAudienceCount,
  createBroadcast,
  listBroadcastTemplates,
  saveBroadcastAsTemplate,
  savedBroadcastAudience,
  sendBroadcast,
  updateBroadcast,
  type Broadcast,
  type BroadcastAudience,
  type BroadcastChannel,
} from '@/lib/dirCommsApi';
import { useClients } from '@/lib/useClients';
import { listCostCenters, listDepartments } from '@/lib/orgApi';
import { usePrompt, useConfirm } from '@/lib/confirm';
import { cn } from '@/lib/cn';
import { fmtDateTime, utcToZonedDatetimeInput } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';

/**
 * The one broadcast composer (Communications' "Broadcast" button and
 * Directory & comms → Broadcasts both open it). Targeting by client,
 * department and cost center, channels that say why they can't be used,
 * the audience counted as you pick, start-from-a-template, and save as a
 * template. Sending always goes through useSendBroadcast's confirm, which
 * names how many people and by which channels.
 */

export const BROADCAST_CHANNEL_LABELS: Record<BroadcastChannel, string> = {
  IN_APP: 'In-app',
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "In-app + email". */
export const channelPhrase = (channels: BroadcastChannel[]) =>
  (channels.length ? channels : (['IN_APP'] as BroadcastChannel[]))
    .map((c, i) => (i === 0 ? BROADCAST_CHANNEL_LABELS[c] : BROADCAST_CHANNEL_LABELS[c].toLowerCase()))
    .join(' + ');

/** Who it reaches, in words: "214 people at Coastal Resort Holdings, Housekeeping". */
export function useAudienceWords() {
  const { clients } = useClients();
  const targets = useQuery({
    queryKey: ['dirComms', 'broadcast-targets'],
    queryFn: async () => {
      const [d, cc] = await Promise.all([listDepartments(), listCostCenters()]);
      return { departments: d.departments, costCenters: cc.costCenters };
    },
    staleTime: 5 * 60_000,
  });
  return (t: { clientId: string | null; departmentId: string | null; costCenterId: string | null; recipientAssociateIds?: string[] | null }, a: BroadcastAudience) => {
    // An explicit list ("Message selected"): the people picked, as many as are still in reach.
    if (t.recipientAssociateIds && t.recipientAssociateIds.length > 0) {
      return `${plural(a.people, 'selected person', 'selected people')}`;
    }
    const where = [
      t.clientId ? clients.find((c) => c.id === t.clientId)?.name : null,
      t.departmentId ? targets.data?.departments.find((d) => d.id === t.departmentId)?.name : null,
      t.costCenterId ? targets.data?.costCenters.find((c) => c.id === t.costCenterId)?.name : null,
    ].filter(Boolean);
    return `${plural(a.people, 'person', 'people')}${where.length ? ` at ${where.join(', ')}` : ' across the company'}`;
  };
}

/**
 * Send a saved broadcast, after a confirm that names the audience and the
 * channels — "Send to 214 people at Coastal Resort Holdings by in-app +
 * email?" — never a bare "Send this broadcast now?".
 */
export function useSendBroadcast() {
  const confirm = useConfirm();
  const words = useAudienceWords();
  const qc = useQueryClient();
  return async (b: Broadcast): Promise<boolean> => {
    let audience: BroadcastAudience;
    try {
      audience = await savedBroadcastAudience(b.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not count who it reaches.');
      return false;
    }
    if (audience.people === 0) {
      toast.error('Nobody matches this targeting — change the client, department or cost center first.');
      return false;
    }
    const noAccount = audience.people - audience.withAccount;
    const ok = await confirm({
      title: `Send to ${words(b, audience)} by ${channelPhrase(b.channels).toLowerCase()}?`,
      description:
        noAccount > 0
          ? `${plural(audience.withAccount, 'person', 'people')} will see it in their inbox. ${plural(noAccount, 'person hasn’t', 'people haven’t')} set up an account yet${b.channels.includes('EMAIL') ? ' and get the email only' : ' and won’t see it until they do'}.`
          : 'Everyone in the audience has an account and sees it in their inbox.',
      confirmLabel: `Send to ${audience.people.toLocaleString()}`,
    });
    if (!ok) return false;
    try {
      const r = await sendBroadcast(b.id);
      // A chosen channel with no provider behind it sent nothing — say so
      // here, not just in the log.
      const off = Object.values(r.notConfigured ?? {});
      if (off.length > 0) toast.warning(`Sent to ${plural(r.recipientCount, 'inbox', 'inboxes')} — but not every channel: ${off.join(' ')}`);
      else toast.success(`Sent — ${plural(r.recipientCount, 'inbox', 'inboxes')}${b.channels.includes('SMS') && r.phoneCount !== undefined ? ` and ${plural(r.phoneCount, 'text', 'texts')}` : ''}.`);
      void qc.invalidateQueries({ queryKey: ['dirComms', 'broadcasts'] });
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the broadcast.');
      return false;
    }
  };
}

export function BroadcastDrawer({
  broadcast,
  recipients = null,
  onClose,
  onSaved,
}: {
  /** Null = create; a DRAFT broadcast = edit in place. */
  broadcast: Broadcast | null;
  /**
   * An explicit list of people ("Message selected" on People). The
   * client / department / cost-center targeting gives way to it; the API
   * still sends only to the active people in the sender's reach.
   */
  recipients?: ReadonlyArray<{ id: string; name: string }> | null;
  onClose: () => void;
  /** After a save (and a send, when "Save & send" was used). */
  onSaved: () => void;
}) {
  const isEdit = broadcast !== null;
  const qc = useQueryClient();
  const prompt = usePrompt();
  const send = useSendBroadcast();
  const words = useAudienceWords();
  const [title, setTitle] = useState(broadcast?.title ?? '');
  const [body, setBody] = useState(broadcast?.body ?? '');
  const [channels, setChannels] = useState<BroadcastChannel[]>(broadcast?.channels?.length ? broadcast.channels : ['IN_APP']);
  const [clientId, setClientId] = useState(broadcast?.clientId ?? '');
  const [departmentId, setDepartmentId] = useState(broadcast?.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(broadcast?.costCenterId ?? '');
  const [scheduledFor, setScheduledFor] = useState(broadcast?.scheduledFor ? utcToZonedDatetimeInput(broadcast.scheduledFor) : '');
  const [saving, setSaving] = useState(false);

  const { clients, isLoading: clientsLoading, isError: clientsError, refetch: refetchClients } = useClients();
  const targetsQuery = useQuery({
    queryKey: ['dirComms', 'broadcast-targets'],
    queryFn: async () => {
      const [d, cc] = await Promise.all([listDepartments(), listCostCenters()]);
      return { departments: d.departments, costCenters: cc.costCenters };
    },
    staleTime: 5 * 60_000,
  });
  const departments: Department[] | null = targetsQuery.data?.departments ?? null;
  const costCenters: CostCenter[] | null = targetsQuery.data?.costCenters ?? null;
  const visibleDepartments = useMemo(() => (departments ?? []).filter((d) => !clientId || d.clientId === clientId), [departments, clientId]);
  const visibleCostCenters = useMemo(() => (costCenters ?? []).filter((c) => !clientId || c.clientId === clientId), [costCenters, clientId]);

  const channelsQuery = useQuery({ queryKey: ['communications', 'channels'], queryFn: listChannels, staleTime: 5 * 60_000 });
  const availability = new Map((channelsQuery.data?.channels ?? []).map((c) => [c.channel, c]));
  const templates = useQuery({ queryKey: ['dirComms', 'broadcast-templates'], queryFn: listBroadcastTemplates, enabled: !isEdit });

  // The explicit list: the people picked, or a saved draft's own list.
  const recipientIds = useMemo(
    () => (recipients?.length ? recipients.map((r) => r.id) : broadcast?.recipientAssociateIds?.length ? broadcast.recipientAssociateIds : null),
    [recipients, broadcast],
  );
  // The audience, counted as the targeting changes.
  const target = recipientIds
    ? { clientId: null, departmentId: null, costCenterId: null, recipientAssociateIds: recipientIds }
    : { clientId: clientId || null, departmentId: departmentId || null, costCenterId: costCenterId || null };
  const [debounced, setDebounced] = useState(target);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(target), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, departmentId, costCenterId, recipientIds]);
  const audience = useQuery({ queryKey: ['dirComms', 'audience', debounced], queryFn: () => broadcastAudienceCount(debounced) });

  const applyTemplate = (id: string) => {
    const t = templates.data?.broadcasts.find((x) => x.id === id);
    if (!t) return;
    setTitle(t.title);
    setBody(t.body);
    setChannels(t.channels.length ? t.channels : ['IN_APP']);
    // A template's wording and channels; its targeting gives way to the people picked.
    if (!recipientIds) {
      setClientId(t.clientId ?? '');
      setDepartmentId(t.departmentId ?? '');
      setCostCenterId(t.costCenterId ?? '');
    }
  };

  const toggleChannel = (c: BroadcastChannel) => {
    if (c === 'IN_APP') return; // every broadcast lands in the inbox
    setChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]));
  };

  /** Save, returning the saved row (for send / template). */
  const save = async (): Promise<Broadcast | null> => {
    if (!title.trim() || !body.trim()) {
      toast.error('Title and body required.');
      return null;
    }
    const payload = {
      title: title.trim(),
      body: body.trim(),
      channels,
      ...target,
      scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
    };
    setSaving(true);
    try {
      let id = broadcast?.id;
      if (isEdit && broadcast) await updateBroadcast(broadcast.id, payload);
      else id = (await createBroadcast(payload)).id;
      void qc.invalidateQueries({ queryKey: ['dirComms', 'broadcasts'] });
      const status: Broadcast['status'] = payload.scheduledFor ? 'SCHEDULED' : 'DRAFT';
      return {
        ...(broadcast ?? { sentAt: null, receiptCount: 0, createdAt: new Date().toISOString() }),
        id: id!,
        ...payload,
        status,
      } as Broadcast;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the broadcast.');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const onSave = async () => {
    const saved = await save();
    if (!saved) return;
    toast.success(scheduledFor ? `Broadcast scheduled for ${fmtDateTime(saved.scheduledFor)}.` : isEdit ? 'Broadcast updated.' : 'Broadcast draft saved.');
    onSaved();
  };
  const onSaveAndSend = async () => {
    const saved = await save();
    if (!saved) return;
    if (await send(saved)) onSaved();
  };
  const onSaveTemplate = async () => {
    const name = await prompt({
      title: 'Save as a template',
      description: 'The wording, channels and targeting are kept for next time. Templates are never sent.',
      reasonLabel: 'Template name',
      reasonPlaceholder: 'Holiday schedule reminder',
      reasonMaxLength: 120,
      confirmLabel: 'Save template',
    });
    if (!name) return;
    const saved = await save();
    if (!saved) return;
    try {
      await saveBroadcastAsTemplate(saved.id, name);
      void qc.invalidateQueries({ queryKey: ['dirComms', 'broadcast-templates'] });
      toast.success(`Saved as the “${name}” template.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save the template.');
    }
  };

  const a = audience.data;
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{isEdit ? 'Edit broadcast' : recipientIds ? `Message ${recipientIds.length === 1 ? '1 person' : `${recipientIds.length.toLocaleString()} people`}` : 'New broadcast'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!isEdit && (templates.data?.broadcasts.length ?? 0) > 0 && (
          <div>
            <Label htmlFor="broadcast-template">Start from a template</Label>
            <Select id="broadcast-template" className="mt-1" defaultValue="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">Blank</option>
              {templates.data!.broadcasts.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.templateName}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div>
          <Label htmlFor="broadcast-title">Title</Label>
          <Input id="broadcast-title" className="mt-1" value={title} maxLength={250} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="broadcast-body">Body</Label>
          <Textarea id="broadcast-body" className="mt-1 min-h-32" value={body} onChange={(e) => setBody(e.target.value)} />
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-ink">Channels</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(['IN_APP', 'EMAIL', 'SMS', 'PUSH'] as BroadcastChannel[]).map((c) => {
              const info = availability.get(c);
              const disabled = c !== 'IN_APP' && info !== undefined && !info.available;
              const on = channels.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled || c === 'IN_APP'}
                  title={disabled ? (info?.reason ?? undefined) : c === 'IN_APP' ? 'Every broadcast lands in the inbox' : undefined}
                  onClick={() => toggleChannel(c)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs',
                    on ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink-muted hover:text-ink',
                    disabled && 'cursor-not-allowed opacity-60 hover:text-ink-muted',
                  )}
                >
                  {BROADCAST_CHANNEL_LABELS[c]}
                </button>
              );
            })}
          </div>
          {(() => {
            const off = [...availability.values()].filter((c) => !c.available && c.channel !== 'PUSH' && c.reason);
            return off.length ? <p className="mt-1 text-xs text-ink-muted">{off.map((c) => `${BROADCAST_CHANNEL_LABELS[c.channel as BroadcastChannel]}: ${c.reason}`).join(' ')}</p> : null;
          })()}
        </fieldset>

        {recipientIds ? (
          <div>
            <p className="text-sm font-medium text-ink">To</p>
            <p className="mt-1 text-sm text-ink" data-testid="broadcast-recipients">
              {recipients?.length
                ? `${recipients.slice(0, 5).map((r) => r.name).join(', ')}${recipients.length > 5 ? ` and ${(recipients.length - 5).toLocaleString()} more` : ''}`
                : `${recipientIds.length.toLocaleString()} people picked on People`}
            </p>
          </div>
        ) : targetsQuery.isError || clientsError ? (
          <ErrorBanner
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void targetsQuery.refetch();
                  if (clientsError) void refetchClients();
                }}
              >
                Retry
              </Button>
            }
          >
            Could not load targeting options.
          </ErrorBanner>
        ) : (
          <>
            <div>
              <Label htmlFor="broadcast-client">Client</Label>
              <Select
                id="broadcast-client"
                className="mt-1"
                value={clientId}
                disabled={clientsLoading}
                onChange={(e) => {
                  setClientId(e.target.value);
                  setDepartmentId('');
                  setCostCenterId('');
                }}
              >
                <option value="">{clientsLoading ? 'Loading clients…' : 'All clients'}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="broadcast-dept">Department</Label>
                <Select id="broadcast-dept" className="mt-1" value={departmentId} disabled={departments === null} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">{departments === null ? 'Loading departments…' : 'All departments'}</option>
                  {visibleDepartments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="broadcast-cc">Cost center</Label>
                <Select id="broadcast-cc" className="mt-1" value={costCenterId} disabled={costCenters === null} onChange={(e) => setCostCenterId(e.target.value)}>
                  <option value="">{costCenters === null ? 'Loading cost centers…' : 'All cost centers'}</option>
                  {visibleCostCenters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </>
        )}

        <p className="flex items-center gap-2 rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" role="status" aria-live="polite">
          <Users className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
          {audience.isPending || !a ? (
            'Counting who this reaches…'
          ) : a.people === 0 ? (
            'Nobody matches this targeting.'
          ) : (
            <span>
              Reaches {words(target, a)}
              <span className="text-ink-muted">
                {' '}
                · {a.withAccount.toLocaleString()} with an account{channels.includes('SMS') ? ` · ${a.withPhone.toLocaleString()} with a phone` : ''}
              </span>
            </span>
          )}
        </p>

        <div>
          <Label htmlFor="broadcast-when">Schedule (optional)</Label>
          <Input id="broadcast-when" type="datetime-local" className="mt-1" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
          <div className="mt-1 text-xs text-ink-muted">
            {scheduledFor ? `Will be scheduled for ${fmtDateTime(new Date(scheduledFor))}.` : 'Leave empty to send now or keep it as a draft.'}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter className="flex-wrap">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={() => void onSaveTemplate()} disabled={saving}>
          <BookmarkPlus className="h-4 w-4" aria-hidden="true" /> Save as template
        </Button>
        <Button variant="secondary" onClick={() => void onSave()} disabled={saving}>
          {scheduledFor ? 'Schedule' : 'Save draft'}
        </Button>
        {!scheduledFor && (
          <Button onClick={() => void onSaveAndSend()} disabled={saving || a?.people === 0}>
            Save &amp; send…
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
