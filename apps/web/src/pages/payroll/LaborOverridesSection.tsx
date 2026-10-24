import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { activateLaborRuleSet, createLaborOverride, listLaborRuleSets, retireLaborRuleSet, type LaborRuleSet, type LaborRuleSite } from '@/lib/laborRulesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';

/**
 * Brief 2-2 step 6 — the organization's and each site's own rules on the
 * Rules page: union contracts and company policy on top of the law. Drafts
 * show in the checks; pay uses a rule only once signed with a note. The API
 * lets an override add protection only, whatever is entered here.
 */

const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

function NewOverrideDrawer({ sites, onClose, onSaved }: { sites: LaborRuleSite[]; onClose: () => void; onSaved: () => void }) {
  const [level, setLevel] = useState<'TENANT' | 'SITE'>('TENANT');
  const [siteId, setSiteId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [weekly, setWeekly] = useState('');
  const [daily, setDaily] = useState('');
  const [restHours, setRestHours] = useState('');
  const [restPremium, setRestPremium] = useState('');
  const [otSeverity, setOtSeverity] = useState<'' | 'warn' | 'block'>('');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const params: Record<string, unknown> = {};
    const overtime = {
      ...(num(weekly) !== undefined ? { weeklyThreshold: num(weekly) } : {}),
      ...(num(daily) !== undefined ? { dailyThreshold: num(daily), dailyMultiplier: 1.5 } : {}),
    };
    if (Object.keys(overtime).length) params.overtime = overtime;
    if (num(restHours) !== undefined) params.restBetweenShifts = { minHours: num(restHours), premiumHours: num(restPremium) ?? 0 };
    if (otSeverity) params.severity = { overtime: otSeverity };
    if (!Object.keys(params).length) return void toast.error('Set at least one rule.');
    if (level === 'SITE' && !siteId) return void toast.error('Choose the site.');
    if (source.trim().length < 3) return void toast.error('Say where the rule comes from (a contract, a policy).');
    setSaving(true);
    try {
      await createLaborOverride({ level, siteId: level === 'SITE' ? siteId : null, effectiveFrom, params, source: source.trim() });
      toast.success('Saved as a draft. Pay uses it once signed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New rule of our own</DrawerTitle>
        <DrawerDescription>Adds protection on top of the law (a union contract, a company policy). It never lowers what the law sets.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Applies to" required>
          {(p) => (
            <Select {...p} value={level} onChange={(e) => setLevel(e.target.value as 'TENANT' | 'SITE')}>
              <option value="TENANT">Every site</option>
              <option value="SITE">One site</option>
            </Select>
          )}
        </Field>
        {level === 'SITE' && (
          <Field label="Site" required>
            {(p) => (
              <Select {...p} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">Choose a site</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="From" required>
          {(p) => <Input {...p} type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />}
        </Field>
        <Field label="Weekly overtime after (hours)" hint="Only a number lower than the law’s takes effect.">
          {(p) => <Input {...p} inputMode="decimal" value={weekly} onChange={(e) => setWeekly(e.target.value)} />}
        </Field>
        <Field label="Daily overtime after (hours)">{(p) => <Input {...p} inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />}</Field>
        <Field label="Minimum rest between shifts (hours)">
          {(p) => <Input {...p} inputMode="decimal" value={restHours} onChange={(e) => setRestHours(e.target.value)} />}
        </Field>
        {restHours.trim() !== '' && (
          <Field label="Premium for a short rest (hours of pay)">
            {(p) => <Input {...p} inputMode="decimal" value={restPremium} onChange={(e) => setRestPremium(e.target.value)} />}
          </Field>
        )}
        <Field label="When scheduling would cause overtime">
          {(p) => (
            <Select {...p} value={otSeverity} onChange={(e) => setOtSeverity(e.target.value as '' | 'warn' | 'block')}>
              <option value="">As the law’s default (warn)</option>
              <option value="warn">Warn</option>
              <option value="block">Block</option>
            </Select>
          )}
        </Field>
        <Field label="Source" required hint="The contract clause or policy this comes from.">
          {(p) => <Input {...p} value={source} onChange={(e) => setSource(e.target.value)} maxLength={1000} />}
        </Field>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={saving}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function ManageOverrideDrawer({ set, siteName, onClose, onChanged }: { set: LaborRuleSet; siteName: string | null; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {siteName ?? 'Every site'} · from {set.effectiveFrom} · v{set.version}
        </DrawerTitle>
        <DrawerDescription>{set.source}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <pre className="overflow-x-auto rounded-md bg-navy-secondary/40 p-3 text-xs text-white">{JSON.stringify(set.params, null, 2)}</pre>
        {set.status === 'DRAFT' && (
          <Field label="Sign-off note" required hint="Who approved it, on what (a memo, a signed contract).">
            {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
          </Field>
        )}
        {set.approvedAt && (
          <p className="text-xs text-silver">
            Signed {set.approvedAt.slice(0, 10)} by {set.approvedBy}
            {set.approvalNote ? ` — ${set.approvalNote}` : ''}
          </p>
        )}
      </DrawerBody>
      <DrawerFooter>
        {set.status !== 'RETIRED' && (
          <Button variant="ghost" className="text-silver hover:text-alert" disabled={busy} onClick={() => (confirmRetire ? void act(() => retireLaborRuleSet(set.id), 'Retired.') : setConfirmRetire(true))}>
            {confirmRetire ? 'Confirm retire' : 'Retire'}
          </Button>
        )}
        {set.status === 'DRAFT' && (
          <Button disabled={busy || note.trim().length < 5} onClick={() => void act(() => activateLaborRuleSet(set.id, note.trim()), 'Signed.')}>
            Sign
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}

const STATUS: Record<LaborRuleSet['status'], { label: string; variant: 'success' | 'pending' | 'default' }> = {
  ACTIVE: { label: 'Signed', variant: 'success' },
  DRAFT: { label: 'Draft', variant: 'pending' },
  RETIRED: { label: 'Retired', variant: 'default' },
};

export function LaborOverridesSection({ sites }: { sites: LaborRuleSite[] }) {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['labor-rules', 'sets'], queryFn: () => listLaborRuleSets() });
  const [showNew, setShowNew] = useState(false);
  const [managing, setManaging] = useState<LaborRuleSet | null>(null);
  const own = (q.data?.sets ?? []).filter((s) => !s.shipped);
  const siteName = (id: string | null) => (id ? (sites.find((s) => s.id === id)?.name ?? 'A site') : null);
  const refresh = () => {
    setShowNew(false);
    setManaging(null);
    void qc.invalidateQueries({ queryKey: ['labor-rules'] });
  };
  return (
    <section aria-labelledby="own-title" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="own-title" className="text-base font-semibold text-white">
          Our own rules
        </h2>
        {canManage && (
          <Button size="sm" className="ml-auto" onClick={() => setShowNew(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> New rule
          </Button>
        )}
      </div>
      <p className="text-sm text-silver">Union contracts and company policy on top of the law, for every site or one. A draft shows here and in the checks; pay uses it only once signed.</p>
      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="p-6">
              <QueryError what="your rules" query={q} />
            </div>
          ) : !q.data ? (
            <div className="p-6">
              <SkeletonRows count={2} />
            </div>
          ) : own.length === 0 ? (
            <p className="p-6 text-sm text-silver">None yet: every site follows the law where it is.</p>
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {own.map((s) => (
                <li key={s.id}>
                  <button type="button" className="flex w-full flex-wrap items-center gap-2 px-4 py-3 text-left text-sm hover:bg-navy-secondary/30 disabled:cursor-default" onClick={() => setManaging(s)} disabled={!canManage}>
                    <span className="font-medium text-white">{siteName(s.siteId) ?? 'Every site'}</span>
                    <span className="text-silver">
                      from {s.effectiveFrom} · v{s.version}
                    </span>
                    <Badge variant={STATUS[s.status].variant} size="sm">
                      {STATUS[s.status].label}
                    </Badge>
                    <span className="w-full truncate text-xs text-silver sm:w-auto">{s.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {showNew && <NewOverrideDrawer sites={sites} onClose={() => setShowNew(false)} onSaved={refresh} />}
      {managing && <ManageOverrideDrawer set={managing} siteName={siteName(managing.siteId)} onClose={() => setManaging(null)} onChanged={refresh} />}
    </section>
  );
}
