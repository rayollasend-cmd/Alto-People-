/**
 * "Share trip": the phone's own share sheet when it has one (Messages,
 * WhatsApp …), else the link on the clipboard. A share the rider closed
 * is not an error.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function shareOrCopy(data: { url: string; title: string; text: string }): Promise<ShareOutcome> {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { share?: (d: ShareData) => Promise<void> });
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share(data);
      return 'shared';
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
      // A share sheet that can't open (no permission, an insecure page): copy instead.
    }
  }
  try {
    if (!nav?.clipboard?.writeText) return 'failed';
    await nav.clipboard.writeText(data.url);
    return 'copied';
  } catch {
    return 'failed';
  }
}
