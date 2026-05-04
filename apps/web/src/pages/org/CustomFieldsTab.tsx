import { useEffect, useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  createDefinition,
  deleteDefinition,
  listDefinitions,
  updateDefinition,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@/lib/customFieldsApi';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { toast } from 'sonner';

const ENTITY_TYPES: CustomFieldEntity[] = ['ASSOCIATE', 'POSITION', 'CLIENT'];
const TYPES: CustomFieldType[] = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTISELECT',
];

export function CustomFieldsTab({
  clientId,
  canManage,
}: {
  clientId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<CustomFieldDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<
    CustomFieldDefinition | 'new' | null
  >(null);

  const refresh = async () => {
    try {
      setError(null);
      const res = await listDefinitions({ clientId: clientId || undefined });
      setRows(res.definitions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    setRows(null);
    refresh();
  }, [clientId]);

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Custom fields</h2>
        {canManage && (
          <Button onClick={() => setDrawerTarget('new')} size="sm">
            <Plus className="h-4 w-4" />
            New custom field
          </Button>
        )}
      </div>
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
      {!rows && <SkeletonRows count={4} rowHeight="h-12" />}
      {rows && rows.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title="No custom fields yet"
          description="Define fields HR can capture per associate, position, or client without changing the schema."
          action={
            canManage ? (
              <Button onClick={() => setDrawerTarget('new')} size="sm">
                <Plus className="h-4 w-4" />
                New custom field
              </Button>
            ) : undefined
          }
        />
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Entity</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Scope</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow
                key={d.id}
                className="group cursor-pointer"
                onClick={(e) => {
                  const t = e.target as HTMLElement;
                  if (t.closest('button, a, input, [data-no-row-click]')) return;
                  setDrawerTarget(d);
                }}
              >
                <TableCell className="font-medium">{d.label}</TableCell>
                <TableCell className="text-silver font-mono text-xs">{d.key}</TableCell>
                <TableCell>
                  <Badge variant="outline">{d.entityType}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="default">{d.type}</Badge>
                </TableCell>
                <TableCell className="text-silver">{d.isRequired ? 'Yes' : '—'}</TableCell>
                <TableCell className="text-silver">
                  {d.clientId ? 'Per-client' : 'Global'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Drawer
        open={drawerTarget !== null}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-md"
      >
        {drawerTarget && (
          <DefinitionDrawer
            target={drawerTarget}
            clientId={clientId}
            canManage={canManage}
            onClose={() => setDrawerTarget(null)}
            onSaved={() => {
              setDrawerTarget(null);
              refresh();
            }}
          />
        )}
      </Drawer>
    </section>
  );
}

function DefinitionDrawer({
  target,
  clientId,
  canManage,
  onClose,
  onSaved,
}: {
  target: CustomFieldDefinition | 'new';
  clientId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const isNew = target === 'new';
  const initial = isNew ? null : target;
  const [entityType, setEntityType] = useState<CustomFieldEntity>(
    initial?.entityType ?? 'ASSOCIATE',
  );
  const [key, setKey] = useState(initial?.key ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [type, setType] = useState<CustomFieldType>(initial?.type ?? 'TEXT');
  const [isRequired, setIsRequired] = useState(initial?.isRequired ?? false);
  const [isSensitive, setIsSensitive] = useState(initial?.isSensitive ?? false);
  const [helpText, setHelpText] = useState(initial?.helpText ?? '');
  const [optionsText, setOptionsText] = useState(
    (initial?.options ?? []).join(', '),
  );
  const [scope, setScope] = useState<'global' | 'client'>(
    initial?.clientId ? 'client' : 'global',
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!key.trim() || !label.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const opts = optionsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const payload = {
        entityType,
        key: key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        label: label.trim(),
        type,
        isRequired,
        isSensitive,
        helpText: helpText.trim() || null,
        options: type === 'SELECT' || type === 'MULTISELECT' ? opts : null,
        clientId: scope === 'client' ? clientId || null : null,
      };
      if (isNew) {
        await createDefinition(payload);
        toast.success('Custom field created');
      } else {
        await updateDefinition(initial!.id, payload);
        toast.success('Custom field updated');
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (isNew) return;
    if (!(await confirm({ title: `Delete "${initial!.label}"?`, destructive: true }))) return;
    setSubmitting(true);
    try {
      await deleteDefinition(initial!.id);
      toast.success('Deleted');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>
          {isNew ? 'New custom field' : initial!.label}
        </DrawerTitle>
        <DrawerDescription>
          {isNew
            ? 'Add a per-entity field without a schema migration.'
            : <span className="font-mono">{initial!.key}</span>}
        </DrawerDescription>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <Field label="Entity">
            {(p) => (
              <Select
                value={entityType}
                onChange={(e) => setEntityType(e.target.value as CustomFieldEntity)}
                disabled={!canManage || !isNew}
                {...p}
              >
                {ENTITY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key" required>
              {(p) => (
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={!canManage || !isNew}
                  placeholder="favorite_shift_pattern"
                  {...p}
                />
              )}
            </Field>
            <Field label="Type">
              {(p) => (
                <Select
                  value={type}
                  onChange={(e) => setType(e.target.value as CustomFieldType)}
                  disabled={!canManage || !isNew}
                  {...p}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Label" required>
            {(p) => (
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={!canManage}
                maxLength={120}
                {...p}
              />
            )}
          </Field>
          <Field label="Help text">
            {(p) => (
              <Input
                value={helpText ?? ''}
                onChange={(e) => setHelpText(e.target.value)}
                disabled={!canManage}
                maxLength={500}
                {...p}
              />
            )}
          </Field>
          {(type === 'SELECT' || type === 'MULTISELECT') && (
            <Field label="Options (comma-separated)">
              {(p) => (
                <Input
                  value={optionsText}
                  onChange={(e) => setOptionsText(e.target.value)}
                  disabled={!canManage}
                  placeholder="A, B, C"
                  {...p}
                />
              )}
            </Field>
          )}
          <div className="flex items-center gap-4 pt-2">
            <label className="text-sm text-white flex items-center gap-2">
              <input
                type="checkbox"
                checked={isRequired}
                onChange={(e) => setIsRequired(e.target.checked)}
                disabled={!canManage}
              />
              Required
            </label>
            <label className="text-sm text-white flex items-center gap-2">
              <input
                type="checkbox"
                checked={isSensitive}
                onChange={(e) => setIsSensitive(e.target.checked)}
                disabled={!canManage}
              />
              Sensitive (hidden from non-HR)
            </label>
          </div>
          {clientId && (
            <Field label="Scope">
              {(p) => (
                <Select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as 'global' | 'client')}
                  disabled={!canManage || !isNew}
                  {...p}
                >
                  <option value="global">Global (all clients)</option>
                  <option value="client">This client only</option>
                </Select>
              )}
            </Field>
          )}
          {error && <ErrorBanner>{error}</ErrorBanner>}
        </div>
      </DrawerBody>
      <DrawerFooter className="justify-between">
        {!isNew && canManage ? (
          <Button
            variant="ghost"
            onClick={remove}
            disabled={submitting}
            className="text-alert hover:text-alert"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {canManage && (
            <Button
              onClick={submit}
              loading={submitting}
              disabled={!key.trim() || !label.trim()}
            >
              {isNew ? 'Create' : 'Save'}
            </Button>
          )}
        </div>
      </DrawerFooter>
    </>
  );
}
