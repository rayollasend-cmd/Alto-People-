import type { NotificationChannel } from '@alto-people/shared';

/**
 * Phase 12 STUB sender. In production this branches on channel and calls
 * Twilio (SMS), FCM (PUSH), Resend/SES (EMAIL). For IN_APP we don't need
 * an external provider — the row in Notification is the delivery.
 *
 * Returning an `externalRef` simulates the provider's message id.
 */
export async function sendStubbed(
  channel: NotificationChannel,
  recipient: { userId: string | null; phone: string | null; email: string | null }
): Promise<{ externalRef: string | null }> {
  // Pretend latency so test assertions about timing aren't too lucky.
  await new Promise((r) => setTimeout(r, 1));

  switch (channel) {
    case 'SMS':
      return { externalRef: `STUB-SMS-${Math.random().toString(36).slice(2, 10)}` };
    case 'PUSH':
      return { externalRef: `STUB-PUSH-${Math.random().toString(36).slice(2, 10)}` };
    case 'EMAIL':
      return { externalRef: `STUB-EMAIL-${Math.random().toString(36).slice(2, 10)}` };
    case 'IN_APP':
      // No external service — the DB row IS the delivery.
      return { externalRef: null };
  }
  // Exhaustive — unreachable but TS doesn't know
  void recipient;
  return { externalRef: null };
}
