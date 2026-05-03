import { useEffect, useState } from 'react';
import { Laptop, Pencil, Plus, Smartphone, Key, IdCard, Car, Shirt, Box } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  assignAsset,
  createAsset,
  deleteAsset,
  listAssets,
  returnAsset,
  updateAsset,
  type Asset,
  type AssetKind,
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
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
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

export function AssetsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [rows, setRows] = useState<Asset[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState<Asset | null>(null);
  const [assignTarget, setAssignTarget] = useState<Asset | null>(null);
  const [returnTarget, setReturnTarget] = useState<Asset | null>(null);
  const [returning, setReturning] = useState(false);

  const refresh = () => {
    setRows(null);
    listAssets()
      .then((r) => setRows(r.assets))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Assets"
        subtitle="Laptops, phones, badges, keys, and other physical items assigned to associates."
        breadcrumbs={[{ label: 'Assets' }]}
      />
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New asset
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Box}
              title="No assets"
              description="Add a laptop, badge, or other item to start tracking it."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Serial</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned to</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
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
                      <TableCell className="font-mono text-xs">{a.serial ?? '—'}</TableCell>
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
                        {a.currentAssignment ? a.currentAssignment.associateName : '—'}
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
                            className="opacity-60 group-hover:opacity-100 text-silver hover:text-white transition inline-flex items-center gap-1 text-xs"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        )}
                        {canManage && (
                          <button
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this asset? Assignment history will be removed.', destructive: true })))
                                return;
                              try {
                                await deleteAsset(a.id);
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                            className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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

function NewAssetDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<AssetKind>('LAPTOP');
  const [label, setLabel] = useState('');
  const [serial, setSerial] = useState('');
  const [model, setModel] = useState('');
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
          <select
            id="new-asset-kind"
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind)}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
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
          />
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
  onClose,
  onSaved,
}: {
  asset: Asset;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<AssetKind>(asset.kind);
  const [label, setLabel] = useState(asset.label);
  const [serial, setSerial] = useState(asset.serial ?? '');
  const [model, setModel] = useState(asset.model ?? '');
  const [notes, setNotes] = useState(asset.notes ?? '');
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
          <select
            id="edit-asset-kind"
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded-md p-2 text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind)}
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
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
          />
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
          <textarea
            id="edit-asset-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            className="mt-1 w-full px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
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
  const [associateId, setAssociateId] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    setSaving(true);
    try {
      await assignAsset({ assetId: asset.id, associateId: associateId.trim() });
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
          <Label htmlFor="assign-asset-associate">Associate ID</Label>
          <Input
            id="assign-asset-associate"
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
            aria-describedby="assign-asset-associate-hint"
          />
          <FormHint id="assign-asset-associate-hint">
            Paste the associate's UUID from the directory.
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
