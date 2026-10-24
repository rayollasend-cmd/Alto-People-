import { useEffect, useState } from 'react';
import { CheckCircle2, Nfc, RefreshCcw, Smartphone, TriangleAlert } from '@/components/ui/icons';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { getKioskPinBadge, reissueKioskPinBadge } from '@/lib/kiosk99Api';
import { isNative } from '@/lib/native/platform';
import { NfcError, nfcAvailability, writeBadge, type NfcErrorCode } from '@/lib/native/nfc';
import { hapticError, hapticSuccess } from '@/lib/haptics';
import { useConfirm } from '@/lib/confirm';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';

/**
 * A person's badge, for HR: write it onto a blank NFC badge (in the native
 * app, on a phone with NFC), or reissue it after a loss — every NFC badge
 * and Wallet pass made before stops working at once; the clock-in number
 * itself doesn't change.
 */

type WriteState = 'idle' | 'holding' | 'written' | 'failed';

const WRITE_FAIL: Record<NfcErrorCode, string> = {
  unsupported: 'This phone can’t write NFC badges.',
  disabled: 'NFC is turned off. Turn it on in the phone’s settings, then try again.',
  cancelled: 'Cancelled — nothing was written.',
  timeout: 'No badge was held to the phone. Try again.',
  not_a_badge: 'That tag couldn’t be read.',
  write_failed: 'The badge couldn’t be written. It may be locked or full — try a blank NTAG213 or NTAG215 badge.',
};

export function BadgeDialog({ pinId, name, onClose }: { pinId: string | null; name: string; onClose: () => void }) {
  const confirm = useConfirm();
  const [nfc, setNfc] = useState<'ready' | 'disabled' | 'unsupported'>('unsupported');
  const [write, setWrite] = useState<WriteState>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const [reissuedTo, setReissuedTo] = useState<number | null>(null);
  const [reissuing, setReissuing] = useState(false);
  const current = useQuery({
    queryKey: ['kiosk', 'badge', pinId],
    queryFn: () => getKioskPinBadge(pinId!),
    enabled: !!pinId,
    retry: false,
  });
  const version = reissuedTo ?? current.data?.badgeVersion ?? null;

  useEffect(() => {
    if (!pinId) return;
    setWrite('idle');
    setFailure(null);
    setReissuedTo(null);
    void nfcAvailability().then(setNfc);
  }, [pinId]);

  const doWrite = async () => {
    if (!pinId) return;
    setFailure(null);
    setWrite('holding');
    try {
      const { badgeToken } = await getKioskPinBadge(pinId);
      await writeBadge(badgeToken);
      hapticSuccess();
      setWrite('written');
    } catch (err) {
      hapticError();
      setWrite('failed');
      setFailure(err instanceof NfcError ? WRITE_FAIL[err.code] : err instanceof ApiError ? err.message : 'The badge couldn’t be written.');
    }
  };

  const reissue = async () => {
    if (!pinId) return;
    const ok = await confirm({
      title: `Reissue ${name}’s badge?`,
      description: 'Their NFC badge and any Wallet pass stop working at once. Their clock-in number stays the same. Write a new badge afterwards, and ask them to add the pass to their wallet again.',
      confirmLabel: 'Reissue badge',
      destructive: true,
    });
    if (!ok) return;
    setReissuing(true);
    try {
      const r = await reissueKioskPinBadge(pinId);
      setReissuedTo(r.badgeVersion);
      setWrite('idle');
      toast.success('Badge reissued. Old badges and passes no longer work.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Couldn’t reissue the badge.');
    } finally {
      setReissuing(false);
    }
  };

  const native = isNative();

  return (
    <Dialog open={!!pinId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{name}’s badge</DialogTitle>
          <DialogDescription>
            A badge clocks them in at the kiosk instead of typing their number — tapped on an NFC kiosk, or shown as the code on their phone’s wallet pass.
          </DialogDescription>
          {version !== null && <p className="text-xs text-ink-muted">Badge version {version} — reissuing makes every older badge and pass stop working.</p>}
        </DialogHeader>

        <div className="rounded-lg border border-line p-4">
          <div className="flex items-start gap-3">
            <Nfc className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">Write an NFC badge</div>
              {!native ? (
                <p className="mt-1 flex items-start gap-1.5 text-sm text-ink-muted">
                  <Smartphone className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Open Kiosk in the Alto People app on a phone with NFC to write badges.
                </p>
              ) : nfc !== 'ready' ? (
                <p className="mt-1 text-sm text-ink-muted">{nfc === 'disabled' ? WRITE_FAIL.disabled : WRITE_FAIL.unsupported}</p>
              ) : write === 'holding' ? (
                <p className="mt-1 text-sm text-ink" role="status" aria-live="polite">
                  Hold the blank badge flat against the top of the phone…
                </p>
              ) : write === 'written' ? (
                <p className="mt-1 flex items-center gap-1.5 text-sm text-success" role="status">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Written. Test it at the kiosk with “Tap badge”.
                </p>
              ) : (
                <p className="mt-1 text-sm text-ink-muted">Use a blank NTAG213 or NTAG215 badge.</p>
              )}
              {failure && (
                <p className="mt-2 flex items-start gap-1.5 text-sm text-alert" role="alert">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {failure}
                </p>
              )}
            </div>
          </div>
          {native && nfc === 'ready' && (
            <div className="mt-3 flex justify-end">
              <Button size="sm" onClick={() => void doWrite()} loading={write === 'holding'}>
                {write === 'written' ? 'Write another' : 'Write badge'}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button variant="outline" onClick={() => void reissue()} loading={reissuing}>
            <RefreshCcw className="h-4 w-4" aria-hidden="true" />
            Reissue badge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
