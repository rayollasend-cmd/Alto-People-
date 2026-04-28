import { useEffect, useState } from 'react';
import { Laptop, Plus, Smartphone, Key, IdCard, Car, Shirt, Box } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  assignAsset,
  createAsset,
  deleteAsset,
  listAssets,
  returnAsset,
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
import { Label } from '@/components/ui/Label';

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
      toast.error('Label is required.');
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
          <Label>Kind</Label>
          <select
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
          <Label>Label</Label>
          <Input
            className="mt-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="MacBook Pro 14, Front desk badge…"
          />
        </div>
        <div>
          <Label>Serial</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
          />
        </div>
        <div>
          <Label>Model</Label>
          <Input
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
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
            placeholder="UUID"
          />
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
