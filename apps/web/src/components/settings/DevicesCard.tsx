import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { forgetMyDevice, listMyDevices } from '@/lib/accessApi';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Access pack — the devices two-step sign-in remembers. Forget one and its
 * next password sign-in asks for the code again. Shown only when the
 * organization turned device trust on.
 */
export function DevicesCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'devices'], queryFn: listMyDevices });
  if (q.data && !q.data.enabled) return null;
  const forget = async (id: string) => {
    try {
      await forgetMyDevice(id);
      toast.success('Forgotten. Its next sign-in asks for the code.');
      await qc.invalidateQueries({ queryKey: ['me', 'devices'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not forget that device.');
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-gold" />
          Remembered devices
        </CardTitle>
        <CardDescription>Devices where a two-step code was entered and remembered{q.data ? ` for ${q.data.days} days` : ''}. Forget any you no longer use.</CardDescription>
      </CardHeader>
      <CardContent>
        {!q.data ? (
          <Skeleton className="h-10 w-full" />
        ) : q.data.devices.length === 0 ? (
          <p className="text-sm text-ink-muted">No device is remembered. Tick “Remember this device” the next time you enter a code.</p>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink">{d.label}</div>
                  <div className="text-xs text-ink-muted">
                    last used {fmtDate(d.lastSeenAt)} · until {fmtDate(d.expiresAt)}{d.ip ? ` · ${d.ip}` : ''}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void forget(d.id)}>Forget</Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
