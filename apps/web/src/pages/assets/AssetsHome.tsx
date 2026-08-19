import { useEffect, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Download, Laptop, Pencil, Plus, Smartphone, Key, IdCard, Car, Shirt, Box } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, ymdLocal } from '@/lib/format';
import {
  assignAsset,
  createAsset,
  deleteAsset,
  listAssets,
  returnAsset,
  updateAsset,
  type Asset,
  type AssetKind,
  type AssetStatus,
} from '@/lib/assets108Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
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
import { FormHint, Label } from '@/components/ui/Label';

const KIND_OPTIONS: AssetKind[] = [
  'LAPTOP',
  'PHONE',
  'TABLET',
  'BADGE',
  'KEY',
  'VEHICLE',
  'UNIFORM',
  'OTHER',
];

const KIND_ICONS: Record<AssetKind, typeof Laptop> = {
  LAPTOP: Laptop,
  PHONE: Smartphone,
  TABLET: Smartphone,
  BADGE: IdCard,
  KEY: Key,
  VEHICLE: Car,
  UNIFORM: Shirt,
  OTHER: Box,
};

const STATUS_OPTIONS: AssetStatus[] = [
  'AVAILABLE',
  'ASSIGNED',
  'IN_REPAIR',
  'LOST',
  'RETIRED',
];

export function AssetsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState<Asset | null>(null);
  const [assignTarget, setAssignTarget] = useState<Asset | null>(null);
  const [returnTarget, setReturnTarget] = useState<Asset | null>(null);
  const [returning, setReturning] = useState(false);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<AssetKind | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<AssetStatus | 'ALL'>('ALL');
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

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listAssets()
      .then((r) => setRows(r.assets))
      .catch(() => setLoadError('Failed to load assets.'));
  };
  useEffect(() => {
    refresh();
  }, []);

  const q = search.trim().toLowerCase();
  const visible = (rows ?? []).filter(
    (a) =>
      (kindFilter === 'ALL' || a.kind === kindFilter) &&
      (statusFilter === 'ALL' || a.status === statusFilter) &&
      (!q ||
        a.label.toLowerCase().includes(q) ||
        (a.serial ?? '').toLowerCase().includes(q) ||
        (a.model ?? '').toLowerCase().includes(q) ||
        (a.currentAssignment?.associateName ?? '').toLowerCase().includes(q)),
  );

  const onExportCsv = () => {
    downloadCsv(`assets-${ymdLocal()}.csv`, [
      ['Kind', 'Label', 'Serial', 'Model', 'Status', 'Assigned to', 'Assigned at', 'Purchased', 'Purchase price', 'Notes'],
      ...visible.map((a) => [
        a.kind,
        a.label,
        a.serial ?? '',
        a.model ?? '',
        a.status,
        a.currentAssignment?.associateName ?? '',
        a.currentAssignment ? fmtDate(a.currentAssignment.assignedAt) : '',
        a.purchasedAt ?? '',
        a.purchasePrice ?? '',
        a.notes ?? '',
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Assets"
        subtitle="Laptops, phones, badges, keys, and other physical items assigned to associates."
        breadcrumbs={[{ label: 'Assets' }]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-silver">
          Showing {visible.length} of {rows?.length ?? 0} asset
          {(rows?.length ?? 0) === 1 ? '' : 's'}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onExportCsv} disabled={visible.length === 0}>
            <Download className="mr-2 h-4 w-4" /> Export CSV
          </Button>
          {canManage && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New asset
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-silver">Kind:</span>
        {(['ALL', ...KIND_OPTIONS] as (AssetKind | 'ALL')[]).map((k) => (
          <Button
            key={k}
            type="button"
            size="xs"
            variant={kindFilter === k ? 'primary' : 'secondary'}
            className="rounded-full"
            aria-pressed={kindFilter === k}
            onClick={() => setKindFilter(k)}
          >
            {k === 'ALL' ? 'All' : k}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-silver">Status:</span>
        {(['ALL', ...STATUS_OPTIONS] as (AssetStatus | 'ALL')[]).map((s) => (
          <Button
            key={s}
            type="button"
            size="xs"
            variant={statusFilter === s ? 'primary' : 'secondary'}
            className="rounded-full"
            aria-pressed={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'ALL' ? 'All' : s}
          </Button>
        ))}
        <Input
          className="ml-auto w-56"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search label, serial, model, holder…"
          aria-label="Search assets"
        />
      </div>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <p role="alert" className="text-sm text-alert">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Box}
              title="No assets"
              description="Add a laptop, badge, or other item to start tracking it."
            />
          ) : visible.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No assets match the current filters.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead className="hidden md:table-cell">Serial</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((a) => {
                  const Icon = KIND_ICONS[a.kind] ?? Box;
                  return (
                    <TableRow key={a.id} className="group">
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm">
                          <Icon className="h-4 w-4 text-silver" />
                          {a.kind}
                        </div>
                      </TableCell>
                      <TableCell className="font-medium text-white">{a.label}</TableCell>
                      <TableCell className="hidden md:table-cell font-mono text-xs">{a.serial ?? '—'}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            a.status === 'AVAILABLE'
                              ? 'success'
                              : a.status === 'ASSIGNED'
                                ? 'accent'
                                : a.status === 'IN_REPAIR'
                                  ? 'pending'
                                  : 'destructive'
                          }
                        >
                          {a.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {a.currentAssignment ? (
                          <AssociateLink associateId={a.currentAssignment.associateId}>
                            {a.currentAssignment.associateName}
                          </AssociateLink>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {canManage && a.status === 'AVAILABLE' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setAssignTarget(a)}
                          >
                            Assign
                          </Button>
                        )}
                        {canManage && a.currentAssignment && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setReturnTarget(a)}
                          >
                            Return
                          </Button>
                        )}
                        {canManage && (
                          <button
                            onClick={() => setEditTarget(a)}
                            aria-label={`Edit ${a.label}`}
                            className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-white transition inline-flex items-center gap-1 text-xs coarse:py-2 coarse:px-1.5"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        )}
                        {canManage && (
                          <button
                            disabled={actionKey !== null}
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this asset? Assignment history will be removed.', destructive: true })))
                                return;
                              await act(`del-${a.id}`, async () => {
                                try {
                                  await deleteAsset(a.id);
                                  toast.success('Asset deleted.');
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              });
                            }}
                            className="can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs coarse:py-2 coarse:px-1.5 disabled:opacity-40"
                          >
                            Delete
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewAssetDrawer
          existing={rows ?? []}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {editTarget && (
        <EditAssetDrawer
          asset={editTarget}
          existing={rows ?? []}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            refresh();
          }}
        />
      )}
      {assignTarget && (
        <AssignDrawer
          asset={assignTarget}
          onClose={() => setAssignTarget(null)}
          onSaved={() => {
            setAssignTarget(null);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={returnTarget !== null}
        onOpenChange={(o) => !o && setReturnTarget(null)}
        title={
          returnTarget
            ? `Return ${returnTarget.label ?? returnTarget.kind}`
            : 'Return asset'
        }
        description={
          returnTarget?.currentAssignment
            ? `Returning from ${returnTarget.currentAssignment.associateName}.`
            : undefined
        }
        confirmLabel="Mark returned"
        requireReason="optional"
        reasonLabel="Return notes (condition, scratches, missing accessories…)"
        reasonPlaceholder="Optional"
        busy={returning}
        onConfirm={async (notes) => {
          if (!returnTarget?.currentAssignment) return;
          setReturning(true);
          try {
            await returnAsset(returnTarget.currentAssignment.id, {
              notes: notes || undefined,
            });
            toast.success('Returned.');
            setReturnTarget(null);
            refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
          } finally {
            setReturning(false);
          }
        }}
      />
    </div>
  );
}

/**
 * Inline (non-blocking) duplicate-serial warning against the loaded list.
 * The server enforces uniqueness per kind+serial on save; this just surfaces
 * the clash on blur before the user submits.
 */
function duplicateSerialWarning(
  existing: Asset[],
  kind: AssetKind,
  serial: string,
  excludeId?: string,
): string | null {
  const s = serial.trim().toLowerCase();
  if (!s) return null;
  const dup = existing.find(
    (a) =>
      a.id !== excludeId &&
      a.kind === kind &&
      (a.serial ?? '').toLowerCase() === s,
  );
  return dup
    ? `Another ${dup.kind} ("${dup.label}") already uses this serial.`
    : null;
}

function NewAssetDrawer({
  existing,
  onClose,
  onSaved,
}: {
  existing: Asset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<AssetKind>('LAPTOP');
  const [label, setLabel] = useState('');
  const [serial, setSerial] = useState('');
  const [model, setModel] = useState('');
  const [serialWarning, setSerialWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!label.trim()) {
      toast.error('Label required.');
      return;
    }
    setSaving(true);
    try {
      await createAsset({
        kind,
        label: label.trim(),
        serial: serial.trim() || null,
        model: model.trim() || null,
      });
      toast.success('Asset created.');
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
        <DrawerTitle>New asset</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label htmlFor="new-asset-kind">Kind</Label>
          <Select
            id="new-asset-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind)}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="new-asset-label">Label</Label>
          <Input
            id="new-asset-label"
            className="mt-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-describedby="new-asset-label-hint"
          />
          <FormHint id="new-asset-label-hint">
            Examples: "MacBook Pro 14", "Front desk badge".
          </FormHint>
        </div>
        <div>
          <Label htmlFor="new-asset-serial">Serial</Label>
          <Input
            id="new-asset-serial"
            className="mt-1 font-mono text-xs"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            onBlur={() =>
              setSerialWarning(duplicateSerialWarning(existing, kind, serial))
            }
          />
          {serialWarning && (
            <p role="alert" className="mt-1 text-xs text-warning">
              {serialWarning}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="new-asset-model">Model</Label>
          <Input
            id="new-asset-model"
            className="mt-1"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function EditAssetDrawer({
  asset,
  existing,
  onClose,
  onSaved,
}: {
  asset: Asset;
  existing: Asset[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<AssetKind>(asset.kind);
  const [label, setLabel] = useState(asset.label);
  const [serial, setSerial] = useState(asset.serial ?? '');
  const [model, setModel] = useState(asset.model ?? '');
  const [notes, setNotes] = useState(asset.notes ?? '');
  const [serialWarning, setSerialWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!label.trim()) {
      toast.error('Label required.');
      return;
    }
    setSaving(true);
    try {
      await updateAsset(asset.id, {
        kind,
        label: label.trim(),
        serial: serial.trim() || null,
        model: model.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success('Asset updated.');
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
        <DrawerTitle>Edit asset</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label htmlFor="edit-asset-kind">Kind</Label>
          <Select
            id="edit-asset-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind)}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="edit-asset-label">Label</Label>
          <Input
            id="edit-asset-label"
            className="mt-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-describedby="edit-asset-label-hint"
          />
          <FormHint id="edit-asset-label-hint">
            Examples: "MacBook Pro 14", "Front desk badge".
          </FormHint>
        </div>
        <div>
          <Label htmlFor="edit-asset-serial">Serial</Label>
          <Input
            id="edit-asset-serial"
            className="mt-1 font-mono text-xs"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            onBlur={() =>
              setSerialWarning(
                duplicateSerialWarning(existing, kind, serial, asset.id),
              )
            }
          />
          {serialWarning && (
            <p role="alert" className="mt-1 text-xs text-warning">
              {serialWarning}
            </p>
          )}
        </div>
        <div>
          <Label htmlFor="edit-asset-model">Model</Label>
          <Input
            id="edit-asset-model"
            className="mt-1"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="edit-asset-notes">Notes</Label>
          <Textarea
            id="edit-asset-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            className="mt-1"
            aria-describedby="edit-asset-notes-hint"
          />
          <FormHint id="edit-asset-notes-hint">
            Condition, accessories, anything HR/IT should know.
          </FormHint>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AssignDrawer({
  asset,
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await assignAsset({ assetId: asset.id, associateId: associate.id });
      toast.success('Assigned.');
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
        <DrawerTitle>Assign — {asset.label}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          {asset.kind} • {asset.serial ?? 'no serial'}
        </div>
        <div>
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
          <FormHint id="assign-asset-associate-hint">
            Search the directory by name.
          </FormHint>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Assigning…' : 'Assign'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
