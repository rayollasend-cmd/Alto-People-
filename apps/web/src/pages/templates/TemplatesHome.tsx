import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Download, FileText, Plus } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  bulkRenderMissing,
  createTemplate,
  deleteTemplate,
  listTemplates,
  listVersions,
  publishVersion,
  renderTemplate,
  saveVersion,
  type DocumentTemplate,
  type DocumentTemplateKind,
  type DocumentTemplateVersion,
} from '@/lib/docTemplatesApi';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  SectionTitle,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { fmtDateTime } from '@/lib/format';
import { toast } from 'sonner';

/**
 * Starting points for the letters HR writes most. Each becomes a DRAFT
 * (v1, unpublished): the [bracketed] parts are for HR to fill in or
 * reword before publishing, and only associate tokens are used, so a
 * render never leaves an unresolved {{ }} behind.
 */
export const STARTER_TEMPLATES: Array<{ key: string; name: string; kind: DocumentTemplateKind; hint: string; subject: string; body: string }> = [
  {
    key: 'offer',
    name: 'Offer letter',
    kind: 'OFFER_LETTER',
    hint: 'Position, start date and pay, with a signature line.',
    subject: 'Your offer, {{ associate.firstName }}',
    body: [
      'Dear {{ associate.firstName }} {{ associate.lastName }},',
      '',
      'We are pleased to offer you the position of {{ associate.jobTitle }} in {{ associate.department }}.',
      '',
      'Start date: [start date]',
      'Pay: [pay rate] per hour',
      'Schedule: [days and hours]',
      '',
      'This offer depends on completing your onboarding paperwork, including the I-9.',
      '',
      'To accept, sign and date below.',
      '',
      'Signature: ______________________   Date: __________',
    ].join('\n'),
  },
  {
    key: 'warning',
    name: 'Written warning',
    kind: 'WARNING_LETTER',
    hint: 'What happened, what is expected, and the next step.',
    subject: 'Written warning: {{ associate.firstName }} {{ associate.lastName }}',
    body: [
      '{{ associate.firstName }} {{ associate.lastName }}',
      '{{ associate.jobTitle }}, {{ associate.department }}',
      '',
      'This is a written warning about: [what happened, with dates].',
      '',
      'What we expect from now on: [the expectation].',
      '',
      'If it happens again, the next step may be [next step].',
      '',
      'You may add your own statement to this record.',
      '',
      'Employee signature: ______________________   Date: __________',
      'Manager signature: ______________________   Date: __________',
    ].join('\n'),
  },
  {
    key: 'nda',
    name: 'Confidentiality agreement',
    kind: 'NDA',
    hint: 'Keeps company information private.',
    subject: 'Confidentiality agreement',
    body: [
      '{{ associate.firstName }} {{ associate.lastName }} agrees to keep private any non-public information about the company, its customers and its people learned while working here, during and after employment.',
      '',
      'This includes: [examples, such as customer lists, pricing and guest details].',
      '',
      'Nothing here stops you from discussing your own pay or working conditions, or from reporting a concern to a government agency.',
      '',
      'Signature: ______________________   Date: __________',
    ].join('\n'),
  },
  {
    key: 'policy',
    name: 'Policy acknowledgement',
    kind: 'POLICY',
    hint: 'Confirms the person read a policy.',
    subject: 'Policy acknowledgement: [policy name]',
    body: [
      'I, {{ associate.firstName }} {{ associate.lastName }}, have received and read [policy name], effective [effective date]. I understand it and agree to follow it.',
      '',
      'Signature: ______________________   Date: __________',
    ].join('\n'),
  },
];

const KIND_LABEL: Record<DocumentTemplateKind, string> = {
  OFFER_LETTER: 'Offer letter',
  POLICY: 'Policy',
  NDA: 'NDA',
  PROMOTION_LETTER: 'Promotion letter',
  TERMINATION_LETTER: 'Termination letter',
  WARNING_LETTER: 'Warning letter',
  GENERIC: 'Generic',
};

// Token paths the server's render context actually resolves (see
// apps/api/src/routes/docTemplates.ts — associate select + flattened
// department/jobTitle). Anything else must come in via custom render data.
const ASSOCIATE_TOKEN_PATHS = [
  'associate.firstName',
  'associate.lastName',
  'associate.email',
  'associate.phone',
  'associate.state',
  'associate.department',
  'associate.jobTitle',
  'associate.id',
] as const;

export function TemplatesHome() {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<DocumentTemplate | null>(null);
  // One in-flight action at a time — a double-click on Delete used to
  // fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const refreshQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => listTemplates(),
  });
  const rows = refreshQuery.data?.templates ?? null;
  const loadError = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load templates.') : null;
  const refresh = () => void refreshQuery.refetch();

  /** A starter becomes a draft template and opens in the editor. */
  const startFrom = async (starter: (typeof STARTER_TEMPLATES)[number]) => {
    await act(`starter-${starter.key}`, async () => {
      try {
        const { id } = await createStarter(starter);
        toast.success(`“${starter.name}” is a draft. Fill in the [bracketed] parts, then publish it.`);
        const next = await refreshQuery.refetch();
        setActive(next.data?.templates.find((t) => t.id === id) ?? null);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not create it.');
      }
    });
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this template?', destructive: true }))) return;
    await act(`del-${id}`, async () => {
      try {
        await deleteTemplate(id);
        toast.success('Template deleted.');
        refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Failed.');
      }
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Document templates"
        subtitle="Mail-merge templates with version history, filled in from each person’s record."
        actions={[{ label: 'New template', icon: Plus, primary: true, onSelect: () => setShowNew(true) }]}
      />
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </ErrorBanner>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <div className="space-y-4 p-4 sm:p-6">
              <EmptyState
                icon={FileText}
                title="No templates yet"
                description="Start from one of these, or write your own with New template. Each starts as a draft you can reword before publishing."
                size="sm"
              />
              <StarterGallery busyKey={actionKey} onPick={(s) => void startFrom(s)} />
            </div>
          ) : (
            <DataGrid<(typeof rows)[number]>
              id="templates"
              caption="Document templates"
              rows={rows}
              rowKey={(t) => t.id}
              search={{ placeholder: 'Name, kind…' }}
              urlState={false}
              exportCsv={{ filename: 'templates' }}
              onRowClick={(t) => setActive(t)}
              rowActionLabel={(t) => `Open template ${t.name}`}
              columns={[
                { key: 'name', header: 'Name', accessor: (t) => t.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'kind', header: 'Kind', accessor: (t) => KIND_LABEL[t.kind], sortable: true, cardMeta: true },
                {
                  key: 'current',
                  header: 'Current version',
                  accessor: (t) => t.currentVersion,
                  sortable: true,
                  searchable: false,
                  cell: (t) => (t.currentVersion ? <Badge variant="success">v{t.currentVersion}</Badge> : <Badge variant="default">Draft only</Badge>),
                },
                { key: 'versions', header: 'Versions', accessor: (t) => t.versionCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                { key: 'renders', header: 'Renders', accessor: (t) => t.renderCount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  cell: (t) => (
                    <Button size="xs" variant="ghost" className="text-silver hover:text-alert" onClick={() => onDelete(t.id)}>
                      Delete
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewTemplateDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {active && (
        <TemplateDrawer
          template={active}
          onClose={() => setActive(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function NewTemplateDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DocumentTemplateKind>('OFFER_LETTER');
  const [starterKey, setStarterKey] = useState('');
  const [saving, setSaving] = useState(false);
  const pickStarter = (key: string) => {
    setStarterKey(key);
    const s = STARTER_TEMPLATES.find((x) => x.key === key);
    if (s) {
      setKind(s.kind);
      if (!name.trim()) setName(s.name);
    }
  };
  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      const starter = STARTER_TEMPLATES.find((x) => x.key === starterKey);
      if (starter) await createStarter({ ...starter, name: name.trim(), kind });
      else await createTemplate({ name: name.trim(), kind });
      toast.success(starter ? 'Template created as a draft from the starter.' : 'Template created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New template</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label htmlFor="tpl-starter">Start from</Label>
          <Select id="tpl-starter" className="mt-1" value={starterKey} onChange={(e) => pickStarter(e.target.value)}>
            <option value="">A blank page</option>
            {STARTER_TEMPLATES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentTemplateKind)}
          >
            {(Object.keys(KIND_LABEL) as DocumentTemplateKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function TemplateDrawer({
  template,
  onClose,
  onChanged,
}: {
  template: DocumentTemplate;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [renderResult, setRenderResult] = useState<{
    body: string;
    unresolvedTokens: string[];
    /** Set when the render was also filed to the associate's vault. */
    filedDocumentId: string | null;
  } | null>(null);
  const [renderTarget, setRenderTarget] = useState<PickedAssociate | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Bulk backfill for the scorecard's offer-letter signal.
  const [bulkConfirming, setBulkConfirming] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<Awaited<
    ReturnType<typeof bulkRenderMissing>
  > | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const onBulkGenerate = async () => {
    setBulkConfirming(false);
    setBulkBusy(true);
    try {
      const r = await bulkRenderMissing(template.id);
      setBulkResult(r);
      if (r.generated > 0) {
        toast.success(
          `Generated ${r.generated} offer letter${r.generated === 1 ? '' : 's'}.`,
        );
        onChanged();
      } else if (r.missingBefore === 0) {
        toast.success('Nobody is missing an offer letter.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Bulk generation failed.');
    } finally {
      setBulkBusy(false);
    }
  };

  const insertToken = (path: string) => {
    const token = `{{ ${path} }}`;
    const el = bodyRef.current;
    if (!el) {
      setBody((b) => b + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? start;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const refreshQuery = useQuery({
    queryKey: ['TemplateDrawer', 'versions', template.id],
    queryFn: () => listVersions(template.id),
  });
  const versions: DocumentTemplateVersion[] | null = refreshQuery.data?.versions ?? null;
  const versionsError = refreshQuery.error ? refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Could not load versions.' : null;
  useEffect(() => {
    const r = refreshQuery.data;
    if (r === undefined) return;
    const latest = r.versions[0];
    if (latest) {
      setSubject(latest.subject ?? '');
      setBody(latest.body);
    }
  }, [refreshQuery.data]);
  const refresh = () => void refreshQuery.refetch();

  const onSave = async () => {
    if (!body.trim()) {
      toast.error('Body required.');
      return;
    }
    setSaving(true);
    try {
      await saveVersion(template.id, {
        subject: subject.trim() || null,
        body,
      });
      toast.success('New version saved as draft.');
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  const onPublish = async (v: DocumentTemplateVersion) => {
    try {
      await publishVersion(template.id, v.id);
      toast.success(`v${v.version} published.`);
      refresh();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onRender = async () => {
    try {
      const r = await renderTemplate(template.id, {
        associateId: renderTarget?.id ?? null,
      });
      setRenderResult({
        body: r.renderedBody,
        unresolvedTokens: r.unresolvedTokens ?? [],
        filedDocumentId: r.filedDocumentId ?? null,
      });
      setCopied(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onCopy = async () => {
    if (!renderResult) return;
    try {
      await navigator.clipboard.writeText(renderResult.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed.');
    }
  };

  const onDownload = () => {
    if (!renderResult) return;
    const safeName =
      template.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') ||
      'render';
    const blob = new Blob([renderResult.body], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-3xl">
      <DrawerHeader>
        <DrawerTitle>{template.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        <Card>
          <CardContent className="space-y-3">
            <div className="text-sm font-medium text-white">Editor</div>
            <div>
              <Label>Subject (optional)</Label>
              <Input
                className="mt-1"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Welcome to {{ associate.firstName }}"
              />
            </div>
            <div>
              <Label>Body</Label>
              <Textarea
                ref={bodyRef}
                className="mt-1 min-h-48 font-mono text-xs"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Dear {{ associate.firstName }}, ..."
              />
              <details className="mt-2 rounded-md border border-navy-secondary bg-navy-secondary/20">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs text-silver hover:text-white">
                  Available tokens
                </summary>
                <div className="flex flex-wrap gap-1.5 px-3 pb-3">
                  {ASSOCIATE_TOKEN_PATHS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      title="Insert at cursor"
                      onClick={() => insertToken(p)}
                      className="rounded border border-navy-secondary bg-navy-secondary/40 px-1.5 py-0.5 font-mono text-xs2 text-steel transition hover:border-steel hover:text-white"
                    >
                      {`{{ ${p} }}`}
                    </button>
                  ))}
                  <div className="w-full pt-1 text-xs2 text-silver/70">
                    Associate tokens resolve when an associate is picked at
                    render time. Any custom key passed in the render data (e.g.{' '}
                    {'{{ startDate }}'}) also resolves.
                  </div>
                </div>
              </details>
            </div>
            <div className="flex gap-2 justify-end">
              <Button onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save new version'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <div className="text-sm font-medium text-white">Versions</div>
            {versionsError ? (
              <ErrorBanner
                action={
                  <Button size="sm" variant="secondary" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {versionsError}
              </ErrorBanner>
            ) : versions === null ? (
              <SkeletonRows count={3} />
            ) : versions.length === 0 ? (
              <div className="text-sm text-silver">
                No versions yet. Save the body above to create v1.
              </div>
            ) : (
              <DataGrid<(typeof versions)[number]>
                id="template-versions"
                caption="Template versions"
                rows={versions}
                rowKey={(v) => v.id}
                search={false}
                urlState={false}
                exportCsv={false}
                columnChooser={false}
                columns={[
                  { key: 'version', header: 'Version', accessor: (v) => v.version, sortable: true, primary: true, cell: (v) => `v${v.version}` },
                  {
                    key: 'status',
                    header: 'Status',
                    accessor: (v) => (v.publishedAt ? 'Published' : 'Draft'),
                    sortable: true,
                    cell: (v) => (v.publishedAt ? <Badge variant="success">Published</Badge> : <Badge variant="default">Draft</Badge>),
                  },
                  {
                    key: 'published',
                    header: 'Published',
                    accessor: (v) => v.publishedAt,
                    sortable: true,
                    searchable: false,
                    cardMeta: true,
                    cell: (v) => fmtDateTime(v.publishedAt),
                  },
                  {
                    key: 'action',
                    header: 'Action',
                    accessor: () => null,
                    searchable: false,
                    csv: () => '',
                    align: 'right',
                    stopRowClick: true,
                    cell: (v) =>
                      !v.publishedAt ? (
                        <Button size="sm" onClick={() => onPublish(v)}>
                          Publish
                        </Button>
                      ) : null,
                  },
                ]}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <div className="text-sm font-medium text-white">Render</div>
            <div>
              <Label>Associate (optional)</Label>
              <div className="mt-1">
                <AssociatePicker value={renderTarget} onChange={setRenderTarget} />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onRender}>Render preview</Button>
              {template.kind === 'OFFER_LETTER' && template.currentVersionId && (
                // The scorecard backfill: file this letter for every approved
                // associate who has none. Two-step confirm — this writes real
                // compliance documents, not previews.
                <Button
                  variant="secondary"
                  onClick={() =>
                    bulkConfirming ? void onBulkGenerate() : setBulkConfirming(true)
                  }
                  onBlur={() => setBulkConfirming(false)}
                  loading={bulkBusy}
                  disabled={bulkBusy}
                >
                  {bulkConfirming
                    ? 'Confirm: file letters for everyone missing one'
                    : 'Generate for everyone missing one'}
                </Button>
              )}
            </div>
            {bulkResult !== null && (
              <div
                role="status"
                className="rounded-md border border-navy-secondary bg-navy-secondary/30 p-3 text-xs text-silver space-y-1"
              >
                <p className="text-white">
                  {bulkResult.missingBefore} missing before this run ·{' '}
                  <span className="text-success">{bulkResult.generated} generated</span>
                  {bulkResult.skippedCount > 0 && (
                    <> · <span className="text-warning">{bulkResult.skippedCount} skipped</span></>
                  )}
                  {bulkResult.remaining > 0 && (
                    <> · {bulkResult.remaining} beyond this run&rsquo;s cap — run again to continue</>
                  )}
                </p>
                {bulkResult.skipped.length > 0 && (
                  <ul className="list-disc pl-4">
                    {bulkResult.skipped.map((s) => (
                      <li key={s.associateId}>
                        {s.associateName} — {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
                {bulkResult.skippedCount > 0 && (
                  <p>
                    Skipped letters had template tokens with no value for that
                    person — fix the missing data (or the template) and run
                    again. Nothing incomplete was filed.
                  </p>
                )}
              </div>
            )}
            {renderResult !== null && (
              <div className="mt-2 space-y-2">
                {renderResult.filedDocumentId && (
                  <p
                    role="status"
                    className="rounded-md border border-success/40 bg-success/10 p-3 text-xs text-success"
                  >
                    Offer letter filed as a PDF on the associate&rsquo;s
                    Documents, and it travels with the audit packet. The
                    scorecard&rsquo;s offer signal tracks approval, not this
                    file, so the tile will not change.
                  </p>
                )}
                {renderResult.unresolvedTokens.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-md border border-alert/40 bg-alert/10 p-3 text-xs text-alert"
                  >
                    {renderResult.unresolvedTokens.length} token
                    {renderResult.unresolvedTokens.length === 1 ? '' : 's'}{' '}
                    resolved to nothing:{' '}
                    <span className="font-mono">
                      {renderResult.unresolvedTokens
                        .map((t) => `{{ ${t} }}`)
                        .join(', ')}
                    </span>{' '}
                    — check for typos.
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={onCopy}>
                    {copied ? (
                      <>
                        <Check className="mr-1.5 h-3.5 w-3.5" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
                      </>
                    )}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onDownload}>
                    <Download className="mr-1.5 h-3.5 w-3.5" /> Download .txt
                  </Button>
                </div>
                <pre className="whitespace-pre-wrap text-xs text-white bg-navy-secondary/40 border border-navy-secondary rounded-md p-3">
                  {renderResult.body}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

/** Create the template, then its first (draft) version from the starter's words. */
async function createStarter(starter: { name: string; kind: DocumentTemplateKind; subject: string; body: string }): Promise<{ id: string }> {
  const { id } = await createTemplate({ name: starter.name, kind: starter.kind });
  await saveVersion(id, { subject: starter.subject, body: starter.body });
  return { id };
}

function StarterGallery({ busyKey, onPick }: { busyKey: string | null; onPick: (s: (typeof STARTER_TEMPLATES)[number]) => void }) {
  return (
    <section aria-label="Start from a starter" className="space-y-3">
      <SectionTitle as="h2" size="sm" title="Start from a starter" description="Opens as a draft in the editor, ready to reword." />
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {STARTER_TEMPLATES.map((s) => (
          <li key={s.key}>
            <button
              type="button"
              disabled={!!busyKey}
              onClick={() => onPick(s)}
              className="flex h-full w-full flex-col rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              <span className="text-sm font-medium text-ink">{s.name}</span>
              <span className="mt-1 text-xs text-ink-muted">{s.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
