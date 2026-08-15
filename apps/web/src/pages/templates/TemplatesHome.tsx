import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, FileText, Plus } from 'lucide-react';
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
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { fmtDateTime } from '@/lib/format';
import { toast } from 'sonner';

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
  const [rows, setRows] = useState<DocumentTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<DocumentTemplate | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listTemplates()
      .then((r) => setRows(r.templates))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Could not load templates.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this template?', destructive: true }))) return;
    try {
      await deleteTemplate(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Document templates"
        subtitle="Mail-merge templates with version history. Use {{ associate.firstName }} tokens."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Templates' }]}
      />
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> New template
        </Button>
      </div>
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
            <EmptyState
              icon={FileText}
              title="No templates"
              description="Define offer letters, policies, NDAs, and warnings with mail-merge tokens."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Kind</TableHead>
                  <TableHead>Current version</TableHead>
                  <TableHead className="hidden lg:table-cell">Versions</TableHead>
                  <TableHead className="hidden lg:table-cell">Renders</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow
                    key={t.id}
                    className="group cursor-pointer"
                    onClick={() => setActive(t)}
                  >
                    <TableCell className="font-medium text-white">
                      {t.name}
                      <div className="md:hidden text-xs2 text-silver/70 truncate font-normal">
                        {KIND_LABEL[t.kind]} · {t.versionCount} version{t.versionCount === 1 ? '' : 's'}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{KIND_LABEL[t.kind]}</TableCell>
                    <TableCell>
                      {t.currentVersion ? (
                        <Badge variant="success">v{t.currentVersion}</Badge>
                      ) : (
                        <Badge variant="default">Draft only</Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">{t.versionCount}</TableCell>
                    <TableCell className="hidden lg:table-cell">{t.renderCount}</TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(t.id);
                        }}
                        className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
                      >
                        Delete
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      await createTemplate({ name: name.trim(), kind });
      toast.success('Template created.');
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
  const [versions, setVersions] = useState<DocumentTemplateVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
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

  const refresh = () => {
    setVersionsError(null);
    listVersions(template.id)
      .then((r) => {
        setVersions(r.versions);
        const latest = r.versions[0];
        if (latest) {
          setSubject(latest.subject ?? '');
          setBody(latest.body);
        }
      })
      .catch((err) =>
        setVersionsError(
          err instanceof ApiError ? err.message : 'Could not load versions.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [template.id]);

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
          <CardContent className="p-4 space-y-3">
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
          <CardContent className="p-4 space-y-3">
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Published</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>
                        v{v.version}
                        <div className="md:hidden text-xs2 text-silver/70 truncate">
                          {fmtDateTime(v.publishedAt)}
                        </div>
                      </TableCell>
                      <TableCell>
                        {v.publishedAt ? (
                          <Badge variant="success">Published</Badge>
                        ) : (
                          <Badge variant="default">Draft</Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {fmtDateTime(v.publishedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {!v.publishedAt && (
                          <Button size="sm" onClick={() => onPublish(v)}>
                            Publish
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
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
                    Documents — it now counts toward the compliance
                    scorecard&rsquo;s &ldquo;Offer letter on file&rdquo;
                    signal and travels with the audit packet.
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
