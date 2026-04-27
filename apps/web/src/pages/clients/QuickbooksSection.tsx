import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link as LinkIcon, Save, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import type { QboAccountConfigInput, QboStatus } from '@alto-people/shared';
import {
  disconnect,
  getStatus,
  startConnect,
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
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';

interface Props {
  clientId: string;
}

const ACCOUNT_FIELDS: ReadonlyArray<{
  key: keyof QboAccountConfigInput;
  label: string;
  hint: string;
}> = [
  { key: 'accountSalariesExpense',   label: 'Salaries Expense',     hint: 'Debit. Total gross + employer-side payroll tax.' },
  { key: 'accountFederalTaxPayable', label: 'Federal Tax Payable',  hint: 'Credit. FIT withheld this period.' },
  { key: 'accountStateTaxPayable',   label: 'State Tax Payable',    hint: 'Credit. SIT withheld this period.' },
  { key: 'accountFicaPayable',       label: 'FICA Payable',         hint: 'Credit. Employee + employer Social Security.' },
  { key: 'accountMedicarePayable',   label: 'Medicare Payable',     hint: 'Credit. Employee + employer Medicare.' },
  { key: 'accountBenefitsPayable',   label: 'Benefits Payable',     hint: 'Credit. Pre-tax deductions (Section 125).' },
  { key: 'accountNetPayPayable',     label: 'Net Pay Payable',      hint: 'Credit. Take-home owed to associates.' },
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

  // Surface the post-OAuth "?qbo=connected" toast and clear the param so
  // a refresh doesn't re-fire the toast.
  useEffect(() => {
    const flag = searchParams.get('qbo');
    if (flag === 'connected') {
      toast.success('QuickBooks connected');
      const next = new URLSearchParams(searchParams);
      next.delete('qbo');
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
          <AccountMappingForm
            clientId={clientId}
            status={status}
            canManage={canManage}
            onSaved={refresh}
          />
        )}
      </CardContent>
    </Card>
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

  useEffect(() => {
    setValues(
      Object.fromEntries(
        ACCOUNT_FIELDS.map((f) => [f.key, (status[f.key as keyof QboStatus] as string | null) ?? ''])
      )
    );
  }, [status]);

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
          Pull these IDs from QuickBooks → Accounting → Chart of Accounts.
          Empty fields fall back to placeholder names; QBO will reject the
          post unless every account exists in the company file.
        </FormHint>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {ACCOUNT_FIELDS.map((f) => (
          <div key={f.key}>
            <Label htmlFor={`qbo-${f.key}`}>{f.label}</Label>
            <Input
              id={`qbo-${f.key}`}
              value={values[f.key] ?? ''}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
              }
              placeholder="e.g. 73"
              disabled={!canManage}
            />
            <FormHint>{f.hint}</FormHint>
          </div>
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
