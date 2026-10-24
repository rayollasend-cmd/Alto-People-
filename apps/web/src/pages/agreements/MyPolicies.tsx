import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollText } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { listMyPolicies, signMyPolicy, type MyPolicy } from '@/lib/policyCampaignsApi';
import { Badge, Button, Card, CardContent, Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle, EmptyState, ErrorBanner, Input, SkeletonRows } from '@/components/ui';
import { Label } from '@/components/ui/Label';
import '@/lib/i18n/en/agr';

/**
 * The person's policies (HR pack 2026-10): what a policy campaign asked
 * them to sign. They read the policy as it was sent to them and sign with
 * their typed name; the signature line records the time, the device and a
 * hash of what they signed.
 */
export function MyPolicies() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState<MyPolicy | null>(null);
  const query = useQuery({ queryKey: ['my', 'policies'], queryFn: listMyPolicies });
  const rows = query.data?.policies ?? null;
  return (
    <Card>
      <CardContent className="p-0">
        {query.isError ? (
          <div className="p-6">
            <ErrorBanner
              action={
                <Button size="sm" variant="secondary" onClick={() => void query.refetch()}>
                  {t('agr.retry')}
                </Button>
              }
            >
              {query.error instanceof ApiError ? query.error.message : t('agr.loadFailed')}
            </ErrorBanner>
          </div>
        ) : rows === null ? (
          <div className="p-6">
            <SkeletonRows count={3} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={ScrollText} title={t('agr.policies.emptyTitle')} description={t('agr.policies.emptyDesc')} />
        ) : (
          <div className="divide-y divide-navy-secondary">
            {rows.map((p) => {
              const overdue = p.status === 'PENDING' && (parseYmd(p.dueOn)?.getTime() ?? Infinity) < Date.now();
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-ink">{p.name}</div>
                    <div className="text-xs text-ink-muted">
                      {p.signedAt ? t('agr.signedOn', { date: fmtDate(p.signedAt) }) : t('agr.policies.dueBy', { date: fmtDate(parseYmd(p.dueOn)) })}
                    </div>
                  </div>
                  <Badge variant={p.status === 'SIGNED' ? 'success' : p.status === 'WAIVED' ? 'default' : overdue ? 'destructive' : 'pending'}>
                    {p.status === 'SIGNED' ? t('agr.status.signed') : p.status === 'WAIVED' ? t('agr.policies.waived') : overdue ? t('agr.policies.overdue') : t('agr.status.pendingSignature')}
                  </Badge>
                  <Button size="sm" variant={p.status === 'PENDING' ? 'primary' : 'outline'} onClick={() => setOpen(p)} className="coarse:min-h-11">
                    {p.status === 'PENDING' ? t('agr.policies.readAndSign') : t('agr.read')}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {open && (
        <PolicyDrawer
          policy={open}
          onClose={() => setOpen(null)}
          onSigned={() => {
            setOpen(null);
            void qc.invalidateQueries({ queryKey: ['my', 'policies'] });
            void qc.invalidateQueries({ queryKey: ['inbox'] });
          }}
        />
      )}
    </Card>
  );
}

function PolicyDrawer({ policy, onClose, onSigned }: { policy: MyPolicy; onClose: () => void; onSigned: () => void }) {
  const { t } = useI18n();
  const [signature, setSignature] = useState('');
  const sign = useMutation({
    mutationFn: () => signMyPolicy(policy.id, signature.trim()),
    onSuccess: () => {
      toast.success(t('agr.signedToast'));
      onSigned();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('agr.failed')),
  });
  const pending = policy.status === 'PENDING';
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} confirmDiscard={() => pending && signature.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>{policy.name}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-line p-3 text-sm leading-relaxed text-ink">{policy.body}</div>
        {pending ? (
          <>
            <div>
              <Label htmlFor="policy-signature">{t('agr.signatureLabel')}</Label>
              <Input id="policy-signature" className="mt-1" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t('agr.signaturePlaceholder')} />
            </div>
            <div className="text-xs text-ink-muted">{t('agr.signatureLegal')}</div>
          </>
        ) : (
          policy.signedAt && (
            <div className="space-y-1 text-xs text-ink-muted">
              <div>{t('agr.policies.signedAs', { name: policy.signature ?? '', when: fmtDateTime(policy.signedAt) })}</div>
              {policy.contentSha256 && <div className="break-all font-mono">SHA-256 {policy.contentSha256}</div>}
            </div>
          )
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('agr.cancel')}
        </Button>
        {pending && (
          <Button onClick={() => sign.mutate()} loading={sign.isPending} disabled={signature.trim().length < 2}>
            {t('agr.sign')}
          </Button>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
