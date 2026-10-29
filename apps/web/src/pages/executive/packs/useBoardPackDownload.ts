import { useState } from 'react';
import { toast } from 'sonner';
import type { ExecPeriodKey } from '@alto-people/shared';
import { boardPackUrl, type ExecFrame } from '@/lib/executiveApi';
import { ymdLocal } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/** "board-pack-quarter-2026-10-27.pdf" — the period it covers and the day it was made. */
export function boardPackFileName(period: ExecPeriodKey, now: Date = new Date()): string {
  return `board-pack-${period}-${ymdLocal(now)}.pdf`;
}

/**
 * The board pack for a frame, fetched with the session and saved as a
 * file. It is built fresh on the server each time, so the button stays
 * busy until the PDF is in hand; a failure says so instead of a dead tab.
 */
export function useBoardPackDownload(frame: Pick<ExecFrame, 'period' | 'compare'>) {
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
      a.download = boardPackFileName(frame.period);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(t('execPortal.packs.failed'));
    } finally {
      setBusy(false);
    }
  };
  return { busy, download };
}
