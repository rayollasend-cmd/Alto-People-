import type { NfcEvent } from '@capgo/capacitor-nfc';
import { isNative } from './platform';

/**
 * NFC badges, through @capgo/capacitor-nfc.
 *
 *   readBadge()   one tap: resolves with the badge credential an NDEF text
 *                 (or URI) record carries — what lib/badgeToken signs.
 *   writeBadge()  HR writes a credential onto a blank NTAG badge.
 *
 * Each resolves or rejects with a NfcError carrying a code the UI words:
 * unsupported / disabled / cancelled / timeout / not_a_badge / write_failed.
 */

export type NfcErrorCode = 'unsupported' | 'disabled' | 'cancelled' | 'timeout' | 'not_a_badge' | 'write_failed';

export class NfcError extends Error {
  constructor(public code: NfcErrorCode, message?: string) {
    super(message ?? code);
  }
}

const BADGE_PREFIX = 'altob1.';

interface NdefRecord {
  tnf: number;
  type: number[];
  id?: number[];
  payload: number[];
}

/** Decode an NDEF Well-known Text ('T') or URI ('U') record's payload. */
export function decodeRecord(r: NdefRecord): string | null {
  const type = String.fromCharCode(...(r.type ?? []));
  const bytes = Uint8Array.from(r.payload ?? []);
  if (type === 'T' && bytes.length > 0) {
    const langLen = bytes[0]! & 0x3f;
    return new TextDecoder().decode(bytes.subarray(1 + langLen));
  }
  if (type === 'U' && bytes.length > 0) {
    return new TextDecoder().decode(bytes.subarray(1));
  }
  return null;
}

/** The credential inside a tag's records — a bare token or a URL carrying `badge=`. */
export function badgeFromRecords(records: NdefRecord[] | undefined | null): string | null {
  for (const r of records ?? []) {
    const text = decodeRecord(r)?.trim();
    if (!text) continue;
    if (text.startsWith(BADGE_PREFIX)) return text;
    const m = text.match(/[?&]badge=([^&#]+)/);
    if (m && decodeURIComponent(m[1]!).startsWith(BADGE_PREFIX)) return decodeURIComponent(m[1]!);
  }
  return null;
}

export async function nfcAvailability(): Promise<'ready' | 'disabled' | 'unsupported'> {
  if (!isNative()) return 'unsupported';
  try {
    const { CapacitorNfc } = await import('@capgo/capacitor-nfc');
    const { supported } = await CapacitorNfc.isSupported();
    if (!supported) return 'unsupported';
    const status = await CapacitorNfc.getStatus().catch(() => ({ status: 'NFC_OK' }) as { status: string });
    return status.status === 'NFC_OK' ? 'ready' : 'disabled';
  } catch {
    return 'unsupported';
  }
}

/** One badge tap. Rejects with NfcError. */
export async function readBadge(opts: { timeoutMs?: number; prompt?: string } = {}): Promise<string> {
  const availability = await nfcAvailability();
  if (availability !== 'ready') throw new NfcError(availability === 'disabled' ? 'disabled' : 'unsupported');
  const { CapacitorNfc } = await import('@capgo/capacitor-nfc');
  return new Promise<string>((resolve, reject) => {
    let done = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void Promise.all(handles.map((h) => h.remove())).catch(() => {});
      void CapacitorNfc.stopScanning().catch(() => {});
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new NfcError('timeout'))), opts.timeoutMs ?? 30_000);
    void (async () => {
      handles.push(
        await CapacitorNfc.addListener('nfcEvent', (event: NfcEvent) => {
          const token = badgeFromRecords(event.tag?.ndefMessage as NdefRecord[] | undefined);
          finish(() => (token ? resolve(token) : reject(new NfcError('not_a_badge'))));
        }),
      );
      handles.push(
        await CapacitorNfc.addListener('nfcSessionEnd', ({ reason }: { reason?: string }) => {
          finish(() => reject(new NfcError(reason === 'sessionTimeout' ? 'timeout' : 'cancelled')));
        }),
      );
      await CapacitorNfc.startScanning({ invalidateAfterFirstRead: true, alertMessage: opts.prompt ?? 'Hold your badge near the top of the phone.' });
    })().catch(() => finish(() => reject(new NfcError('unsupported'))));
  });
}

/** Write a badge credential onto a tag (HR). Rejects with NfcError. */
export async function writeBadge(token: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const availability = await nfcAvailability();
  if (availability !== 'ready') throw new NfcError(availability === 'disabled' ? 'disabled' : 'unsupported');
  const { CapacitorNfc } = await import('@capgo/capacitor-nfc');
  const lang = Array.from(new TextEncoder().encode('en'));
  const text = Array.from(new TextEncoder().encode(token));
  const record = { tnf: 0x01, type: [0x54], id: [], payload: [lang.length & 0x3f, ...lang, ...text] };
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void Promise.all(handles.map((h) => h.remove())).catch(() => {});
      void CapacitorNfc.stopScanning().catch(() => {});
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new NfcError('timeout'))), opts.timeoutMs ?? 45_000);
    void (async () => {
      handles.push(
        await CapacitorNfc.addListener('nfcEvent', () => {
          void CapacitorNfc.write({ allowFormat: true, records: [record] })
            .then(() => finish(resolve))
            .catch(() => finish(() => reject(new NfcError('write_failed'))));
        }),
      );
      handles.push(
        await CapacitorNfc.addListener('nfcSessionEnd', ({ reason }: { reason?: string }) => {
          finish(() => reject(new NfcError(reason === 'sessionTimeout' ? 'timeout' : 'cancelled')));
        }),
      );
      await CapacitorNfc.startScanning({ invalidateAfterFirstRead: false, alertMessage: 'Hold the blank badge near the top of the phone.' });
    })().catch(() => finish(() => reject(new NfcError('unsupported'))));
  });
}
