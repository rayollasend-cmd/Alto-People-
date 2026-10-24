import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Flag } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { acknowledgeFloorFlag, listFloorFlags, type FloorFlag } from '@/lib/floorApi';
import { fmtTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Card, CardContent } from '@/components/ui/Card';
import '@/lib/i18n/en/floorUi';

/**
 * The shift supervisor's side of a flag: what a floor lead raised, open
 * until acknowledged. Acknowledging says "I have it" — to the lead, and
 * to the Inbox count.
 */

const KIND_LABEL: Record<FloorFlag['kind'], MessageKey> = { NO_SHOW: 'floorUi.kindNoShow', HAZARD: 'floorUi.kindHazard', OTHER: 'floorUi.kindFlag' };
const KIND_TONE: Record<FloorFlag['kind'], 'pending' | 'destructive' | 'default'> = { NO_SHOW: 'pending', HAZARD: 'destructive', OTHER: 'default' };

export function FloorFlagsCard({ className }: { className?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['floor', 'flags'], queryFn: () => listFloorFlags('open'), refetchInterval: 60_000 });
  const flags = q.data?.flags ?? [];
  if (flags.length === 0) return null;

  const ack = async (id: string) => {
    setBusy(id);
    try {
      await acknowledgeFloorFlag(id);
      await qc.invalidateQueries({ queryKey: ['floor', 'flags'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('floorUi.ackFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card id="floor-flags" className={cn('animate-enter border-warning/40', className)} data-testid="floor-flags">
      <CardContent className="p-5">
        <SectionTitle icon={Flag} title={t('floorUi.fromTheFloor')} trailing={<span className="text-xs tabular-nums text-ink-muted">{flags.length}</span>} />
        <ul className="divide-y divide-navy-secondary/60">
          {flags.map((f) => (
            <li key={f.id} className="flex items-start gap-3 py-2.5">
              <Badge variant={KIND_TONE[f.kind]} size="sm">
                {t(KIND_LABEL[f.kind])}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink">
                  {f.associate && <span className="font-medium">{f.associate.name} · </span>}
                  {f.note}
                </div>
                <div className="mt-0.5 text-xs text-silver/70">
                  {f.raisedBy} · {fmtTime(f.createdAt)}
                </div>
              </div>
              <Button size="sm" variant="outline" loading={busy === f.id} onClick={() => void ack(f.id)}>
                {t('common.gotIt')}
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
