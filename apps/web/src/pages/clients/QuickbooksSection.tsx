import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link as LinkIcon, Save, Unlink, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { QboAccount, QboAccountConfigInput, QboStatus } from '@alto-people/shared';
import {
  disconnect,
  getStatus,
  listQboAccounts,
  startConnect,
  syncAssociatesToQbo,
  updateAccounts,
} from '@/lib/quickbooksApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { FormHint } from '@/components/ui/Label';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

interface Props {
  clientId: string;
}

const ACCOUNT_FIELDS: ReadonlyArray<{
  key: keyof QboAccountConfigInput;
  label: string;
  hint: string;
  /** QBO classification used to filter the dropdown picker. */
  classification: 'Expense' | 'Liability' | null;
}> = [
  { key: 'accountSalariesExpense',   label: 'Salaries Expense',     hint: 'Debit. Total gross + employer-side payroll tax.', classification: 'Expense' },
  { key: 'accountFederalTaxPayable', label: 'Federal Tax Payable',  hint: 'Credit. FIT withheld this period.',                classification: 'Liability' },
  { key: 'accountStateTaxPayable',   label: 'State Tax Payable',    hint: 'Credit. SIT withheld this period.',                classification: 'Liability' },
  { key: 'accountFicaPayable',       label: 'FICA Payable',         hint: 'Credit. Employee + employer Social Security.',      classification: 'Liability' },
  { key: 'accountMedicarePayable',   label: 'Medicare Payable',     hint: 'Credit. Employee + employer Medicare.',             classification: 'Liability' },
  { key: 'accountBenefitsPayable',   label: 'Benefits Payable',     hint: 'Credit. Pre-tax deductions (Section 125).',         classification: 'Liability' },
  { key: 'accountNetPayPayable',     label: 'Net Pay Payable',      hint: 'Credit. Take-home owed to associates.',             classification: 'Liability' },
];

/**
 * Phase 44 — QuickBooks Online integration. Connect/disconnect the OAuth
 * link, map JE lines onto the client's chart-of-accounts, and surface
 * stub-mode so HR knows when posts are local-only.
 */
export function QuickbooksSection({ clientId }: Props) {
  const { can } = useAuth();
  const canManage = can('process:payroll');

  const [status, setStatus] = useState<QboStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const refresh = useCallback(async () => {
    try {
      const s = await getStatus(clientId);
      setStatus(s);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load QuickBooks status.');
    }
  }, [clientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Surface the post-OAuth "?qbo=connected" toast (or "?qbo_error=...")
  // and clear the param so a refresh doesn't re-fire it.
  useEffect(() => {
    const flag = searchParams.get('qbo');
    const errorCode = searchParams.get('qbo_error');
    if (flag === 'connected') {
      toast.success('QuickBooks connected');
    } else if (errorCode) {
      toast.error('QuickBooks connection failed', {
        description: describeQboError(errorCode),
      });
    }
    if (flag || errorCode) {
      const next = new URLSearchParams(searchParams);
      next.delete('qbo');
      next.delete('qbo_error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const onConnect = async () => {
    setConnecting(true);
    try {
      const { authorizeUrl } = await startConnect(clientId);
      // Full-page redirect — Intuit's OAuth flow needs to own the browser.
      window.location.href = authorizeUrl;
    } catch (err) {
      setConnecting(false);
      toast.error('Could not start QuickBooks connect', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDisconnect = async () => {
    if (!confirm('Disconnect QuickBooks? Future payroll runs will not auto-sync until reconnected.')) return;
    setDisconnecting(true);
    try {
      await disconnect(clientId);
      toast.success('QuickBooks disconnected');
      await refresh();
    } catch (err) {
      toast.error('Could not disconnect', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDisconnecting(false);
    }
  };

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-gold" />
            QuickBooks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-alert text-sm">{error}</p>
        </CardContent>
      </Card>
    );
  }
  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4 text-gold" />
            QuickBooks
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-24" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-4 w-4 text-gold" />
          QuickBooks
          {status.connected ? (
            <Badge>Connected</Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
          {status.stubMode && <Badge variant="outline">Stub mode</Badge>}
        </CardTitle>
        <CardDescription>
          When connected, finalized payroll runs auto-post a balanced
          JournalEntry to your QBO company file. Stub mode means no Intuit
          credentials are configured — JE payloads are logged to the API
          console instead of sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {status.connected ? (
          <ConnectionDetails status={status} />
        ) : (
          <p className="text-sm text-silver">
            No QuickBooks company is linked to this client yet.
          </p>
        )}

        {canManage && (
          <div className="flex flex-wrap gap-2">
            {status.connected ? (
              <Button variant="ghost" onClick={onDisconnect} loading={disconnecting}>
                <Unlink className="h-4 w-4" />
                Disconnect
              </Button>
            ) : (
              <Button onClick={onConnect} loading={connecting}>
                <LinkIcon className="h-4 w-4" />
                Connect QuickBooks
              </Button>
            )}
          </div>
        )}

        {status.connected && (
          <>
            <AccountMappingForm
              clientId={clientId}
              status={status}
              canManage={canManage}
              onSaved={refresh}
            />
            <JeModeToggle
              clientId={clientId}
              status={status}
              canManage={canManage}
              onSaved={refresh}
            />
            {canManage && <AssociateSyncSection clientId={clientId} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function JeModeToggle({
  clientId,
  status,
  canManage,
  onSaved,
}: {
  clientId: string;
  status: QboStatus;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  const setMode = async (mode: 'AGGREGATE' | 'PER_EMPLOYEE') => {
    if (mode === status.jeMode || saving) return;
    setSaving(true);
    try {
      await updateAccounts(clientId, { jeMode: mode });
      toast.success(
        mode === 'PER_EMPLOYEE'
          ? 'Switched to per-employee JE posting'
          : 'Switched to aggregate JE posting'
      );
      await onSaved();
    } catch (err) {
      toast.error('Could not change JE mode', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pt-3 border-t border-navy-secondary">
      <div>
        <h3 className="text-sm font-medium text-white">Journal entry granularity</h3>
        <FormHint>
          AGGREGATE posts one balanced JE per run (sum of every paystub).
          PER_EMPLOYEE posts one JE per associate with EmployeeRef set —
          mirrors how QBO Payroll itself records payroll, but requires
          every associate has been synced to QuickBooks first.
        </FormHint>
      </div>
      <div className="flex flex-wrap gap-2">
        <ModeButton
          label="Aggregate (one JE per run)"
          active={status.jeMode === 'AGGREGATE'}
          disabled={!canManage || saving}
          onClick={() => setMode('AGGREGATE')}
        />
        <ModeButton
          label="Per employee (one JE per paystub)"
          active={status.jeMode === 'PER_EMPLOYEE'}
          disabled={!canManage || saving}
          onClick={() => setMode('PER_EMPLOYEE')}
        />
      </div>
    </div>
  );
}

function ModeButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={
        'px-3 py-1.5 text-xs rounded border transition-colors disabled:opacity-50 ' +
        (active
          ? 'border-gold text-gold bg-gold/10'
          : 'border-silver/30 text-silver/70 hover:border-silver/60 hover:text-silver')
      }
    >
      {label}
    </button>
  );
}

function AssociateSyncSection({ clientId }: { clientId: string }) {
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<{
    scanned: number;
    synced: number;
    failed: number;
    errors: Array<{ associateId: string; name: string; reason: string }>;
  } | null>(null);

  const onSync = async () => {
    setBusy(true);
    try {
      const res = await syncAssociatesToQbo(clientId);
      setLastResult(res);
      if (res.failed === 0) {
        toast.success(`${res.synced} associate(s) synced to QuickBooks`);
      } else {
        toast.warning(`${res.synced} synced, ${res.failed} failed`);
      }
    } catch (err) {
      toast.error('Sync failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 pt-3 border-t border-navy-secondary">
      <div>
        <h3 className="text-sm font-medium text-white">Associate sync</h3>
        <FormHint>
          Pushes every active associate at this client to QuickBooks as an
          Employee (W2) or Vendor (1099). Idempotent — already-synced
          records are updated in place using their cached QBO id.
        </FormHint>
      </div>
      <Button onClick={onSync} loading={busy}>
        <Users className="h-4 w-4" />
        Sync associates to QuickBooks
      </Button>
      {lastResult && (
        <div className="text-xs text-silver/70 space-y-1">
          <div>
            Last run: scanned {lastResult.scanned}, synced {lastResult.synced},
            failed {lastResult.failed}.
          </div>
          {lastResult.errors.slice(0, 5).map((e) => (
            <div key={e.associateId} className="text-alert">
              · {e.name}: {e.reason}
            </div>
          ))}
          {lastResult.errors.length > 5 && (
            <div className="text-alert">… and {lastResult.errors.length - 5} more</div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionDetails({ status }: { status: QboStatus }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
      <div>
        <dt className="text-silver text-xs uppercase tracking-wide">Realm ID</dt>
        <dd className="text-white font-mono">{status.realmId ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-silver text-xs uppercase tracking-wide">Token expires</dt>
        <dd className="text-white">
          {status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '—'}
        </dd>
      </div>
      <div>
        <dt className="text-silver text-xs uppercase tracking-wide">Last refreshed</dt>
        <dd className="text-white">
          {status.lastRefreshedAt ? new Date(status.lastRefreshedAt).toLocaleString() : '—'}
        </dd>
      </div>
    </dl>
  );
}

function AccountMappingForm({
  clientId,
  status,
  canManage,
  onSaved,
}: {
  clientId: string;
  status: QboStatus;
  canManage: boolean;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ACCOUNT_FIELDS.map((f) => [f.key, (status[f.key as keyof QboStatus] as string | null) ?? ''])
    )
  );
  const [saving, setSaving] = useState(false);
  // Wave 3.1 — pull the QBO chart-of-accounts so HR picks accounts from a
  // dropdown instead of typing raw IDs. We start with `null` (loading), then
  // either `[]` (failed/empty — fall back to text input) or the loaded list.
  const [accounts, setAccounts] = useState<QboAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setValues(
      Object.fromEntries(
        ACCOUNT_FIELDS.map((f) => [f.key, (status[f.key as keyof QboStatus] as string | null) ?? ''])
      )
    );
  }, [status]);

  useEffect(() => {
    let alive = true;
    listQboAccounts(clientId)
      .then((res) => {
        if (alive) setAccounts(res.accounts);
      })
      .catch((err) => {
        if (alive) {
          setLoadError(err instanceof ApiError ? err.message : 'Failed to load chart of accounts.');
          setAccounts([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [clientId]);

  const submit = async () => {
    setSaving(true);
    try {
      const body: QboAccountConfigInput = Object.fromEntries(
        ACCOUNT_FIELDS.map((f) => [f.key, values[f.key]?.trim() ? values[f.key].trim() : null])
      );
      await updateAccounts(clientId, body);
      toast.success('Account mapping saved');
      await onSaved();
    } catch (err) {
      toast.error('Could not save account mapping', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-white">Account mapping</h3>
        <FormHint>
          Map each payroll JE line to a GL account in your QuickBooks chart
          of accounts. The list below loads live from QBO; empty fields fall
          back to placeholder names and QBO will reject the post.
        </FormHint>
        {loadError && (
          <p className="text-xs text-alert mt-1">{loadError}</p>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ACCOUNT_FIELDS.map((f) => (
          <AccountPicker
            key={f.key}
            label={f.label}
            hint={f.hint}
            value={values[f.key] ?? ''}
            onChange={(v) =>
              setValues((prev) => ({ ...prev, [f.key]: v }))
            }
            accounts={accounts}
            classification={f.classification}
            disabled={!canManage}
          />
        ))}
      </div>
      {canManage && (
        <Button onClick={submit} loading={saving}>
          <Save className="h-4 w-4" />
          Save mapping
        </Button>
      )}
    </div>
  );
}

function AccountPicker({
  label,
  hint,
  value,
  onChange,
  accounts,
  classification,
  disabled,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  accounts: QboAccount[] | null;
  classification: 'Expense' | 'Liability' | null;
  disabled?: boolean;
}) {
  // Filter to the relevant classification (Expense vs Liability) to keep
  // the picker focused. If no classification on the field, show all.
  const filtered = accounts && classification
    ? accounts.filter((a) => a.classification === classification)
    : accounts ?? [];
  const valueExists = !value || filtered.some((a) => a.id === value);

  return (
    <Field label={label} hint={hint}>
      {(p) =>
        accounts === null ? (
          <Skeleton className="h-9" />
        ) : (
          <Select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            {...p}
          >
            <option value="">— Not mapped —</option>
            {filtered.map((a) => (
              <option key={a.id} value={a.id}>
                {a.isSubAccount ? '— ' : ''}
                {a.name} ({a.accountType})
              </option>
            ))}
            {!valueExists && value && (
              <option value={value}>(unknown id: {value})</option>
            )}
          </Select>
        )
      }
    </Field>
  );
}

function describeQboError(code: string): string {
  switch (code) {
    case 'invalid_callback':
      return 'Intuit returned to Alto without the expected parameters. Try connecting again.';
    case 'invalid_state':
      return 'Connection request expired or was tampered with. Try connecting again.';
    case 'connect_failed':
      return 'Could not exchange the authorization code for a token. Try connecting again.';
    default:
      return 'Try connecting again. If the problem persists, contact support.';
  }
}
