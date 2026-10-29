import { useState } from 'react';
import { toast } from 'sonner';
import { Download } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { boardPackUrl, type ExecFrame } from '@/lib/executiveApi';
import { ymdLocal } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/**
 * The board pack for the frame on screen — fetched and saved as a file
 * (a plain link would open the PDF over the home on a phone, and a failed
 * build would show the API's error page instead of a sentence).
 */
export function BoardPackButton({ frame }: { frame: Pick<ExecFrame, 'period' | 'compare'> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(boardPackUrl(frame), { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `board-pack-${ymdLocal()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Firefox reads the blob after click() returns.
      window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
    } catch {
      toast.error(t('execPortal.home.boardPackFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" onClick={() => void download()} loading={busy} disabled={busy} data-testid="exec-board-pack">
      {!busy && <Download className="h-4 w-4" aria-hidden="true" />}
      {t('execPortal.boardPack')}
    </Button>
  );
}
