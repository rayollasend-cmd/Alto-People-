import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QboSyncSettings, QboSyncStatus } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';
import { importQboHistory, QBO_KEY, relinkQboCharts, saveQboSettings } from '@/lib/books/quickbooksApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useConfirm } from '@/lib/confirm';
import { errMsg } from './qboWords';

/** How the site's dimensions land in QuickBooks, matching the charts again, and bringing QuickBooks' history in. */

export function SettingsPanel({ s, manage }: { s: QboSyncStatus; manage: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<QboSyncSettings>(s.settings);
  const [since, setSince] = useState(`${ymdLocal().slice(0, 4)}-01-01`);
  const refresh = () => qc.invalidateQueries({ queryKey: QBO_KEY });
  const save = useMutation({ mutationFn: () => saveQboSettings(settings), onSuccess: () => { toast.success('Saved. New entries use it from the next sync.'); void refresh(); }, onError: (err) => toast.error(errMsg(err)) });
  const relink = useMutation({
    mutationFn: relinkQboCharts,
    onSuccess: (r) => {
      toast.success(`Matched again: ${r.accounts.matched} accounts matched, ${r.accounts.created} created in QuickBooks, ${r.accounts.imported} brought over.`);
      void refresh();
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  const history = useMutation({
    mutationFn: () => importQboHistory(since),
    onSuccess: (r) => {
      toast.success(`${r.ok} brought in${r.conflicts ? `, ${r.conflicts} waiting for a decision` : ''}${r.errors ? `, ${r.errors} failed (see History)` : ''}.`);
      void refresh();
    },
    onError: (err) => toast.error(errMsg(err)),
  });
  const changed = settings.classMode !== s.settings.classMode || settings.locationMode !== s.settings.locationMode;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>How the books are split in QuickBooks</CardTitle>
          <CardDescription>QuickBooks reports by Class and by Location. Choose what each one carries, so its reports break down the way the site’s do.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Class" hint="Every line tagged with its client (or department) becomes that QuickBooks class.">
            {(p) => (
              <Select value={settings.classMode} disabled={!manage} onChange={(e) => setSettings({ ...settings, classMode: e.target.value as QboSyncSettings['classMode'] })} {...p}>
                <option value="CLIENT">The client</option>
                <option value="DEPARTMENT">The department</option>
                <option value="NONE">Nothing</option>
              </Select>
            )}
          </Field>
          <Field label="Location" hint="Every line tagged with a site goes to that QuickBooks location.">
            {(p) => (
              <Select value={settings.locationMode} disabled={!manage} onChange={(e) => setSettings({ ...settings, locationMode: e.target.value as QboSyncSettings['locationMode'] })} {...p}>
                <option value="SITE">The site</option>
                <option value="NONE">Nothing</option>
              </Select>
            )}
          </Field>
          {manage && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!changed}>
              Save
            </Button>
          )}
        </CardContent>
      </Card>
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Match the charts again</CardTitle>
            <CardDescription>Links any account, vendor or client that isn’t linked yet — by number, then by name — and creates the rest. What’s already linked stays as it is.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => relink.mutate()} loading={relink.isPending} disabled={!manage}>
              Match again
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Bring in QuickBooks’ history</CardTitle>
            <CardDescription>
              On connecting, only changes from then on come over, so payroll and statements the site already has aren’t counted twice. Bring in what your accountant entered in QuickBooks from a date — for history the site doesn’t have.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <Field label="From" className="w-44">
              {(p) => <Input type="date" value={since} max={ymdLocal()} onChange={(e) => setSince(e.target.value)} disabled={!manage} {...p} />}
            </Field>
            <Button
              variant="outline"
              loading={history.isPending}
              disabled={!manage || !since}
              onClick={async () => {
                if (await confirm({ title: `Bring in QuickBooks’ history from ${since}?`, description: 'Transactions entered in QuickBooks on or after this date come into the site’s books. Anything the site sent to QuickBooks itself is skipped, so nothing is counted twice.', confirmLabel: 'Bring it in' })) history.mutate();
              }}
            >
              Bring it in
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
