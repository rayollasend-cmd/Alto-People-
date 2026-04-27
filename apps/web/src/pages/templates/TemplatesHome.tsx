import { useEffect, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
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
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
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

export function TemplatesHome() {
  const [rows, setRows] = useState<DocumentTemplate[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [active, setActive] = useState<DocumentTemplate | null>(null);

  const refresh = () => {
    setRows(null);
    listTemplates()
      .then((r) => setRows(r.templates))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this template?')) return;
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
          {rows === null ? (
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
                  <TableHead>Kind</TableHead>
                  <TableHead>Current version</TableHead>
                  <TableHead>Versions</TableHead>
                  <TableHead>Renders</TableHead>
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
                    <TableCell className="font-medium text-white">{t.name}</TableCell>
                    <TableCell>{KIND_LABEL[t.kind]}</TableCell>
                    <TableCell>
                      {t.currentVersion ? (
                        <Badge variant="success">v{t.currentVersion}</Badge>
                      ) : (
                        <Badge variant="pending">Draft only</Badge>
                      )}
                    </TableCell>
                    <TableCell>{t.versionCount}</TableCell>
                    <TableCell>{t.renderCount}</TableCell>
                    <TableCell className="text-right">
                      <button
                        data-no-row-click
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(t.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-silver hover:text-alert transition text-xs"
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as DocumentTemplateKind)}
          >
            {(Object.keys(KIND_LABEL) as DocumentTemplateKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
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
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [renderPreview, setRenderPreview] = useState<string | null>(null);
  const [renderTargetId, setRenderTargetId] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = () => {
    listVersions(template.id)
      .then((r) => {
        setVersions(r.versions);
        const latest = r.versions[0];
        if (latest) {
          setSubject(latest.subject ?? '');
          setBody(latest.body);
        }
      })
      .catch(() => setVersions([]));
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
      toast.success('New version saved (DRAFT).');
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
        associateId: renderTargetId.trim() || null,
      });
      setRenderPreview(r.renderedBody);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
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
                className="mt-1 min-h-48 font-mono text-xs"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Dear {{ associate.firstName }}, ..."
              />
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
            {versions === null ? (
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
                    <TableHead>Published</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>v{v.version}</TableCell>
                      <TableCell>
                        {v.publishedAt ? (
                          <Badge variant="success">Published</Badge>
                        ) : (
                          <Badge variant="pending">Draft</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {v.publishedAt ? new Date(v.publishedAt).toLocaleString() : '—'}
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
              <Label>Associate ID (optional)</Label>
              <Input
                className="mt-1 font-mono text-xs"
                value={renderTargetId}
                onChange={(e) => setRenderTargetId(e.target.value)}
                placeholder="UUID"
              />
            </div>
            <Button onClick={onRender}>Render preview</Button>
            {renderPreview !== null && (
              <pre className="mt-2 whitespace-pre-wrap text-xs text-white bg-navy-secondary/40 border border-navy-secondary rounded-md p-3">
                {renderPreview}
              </pre>
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
