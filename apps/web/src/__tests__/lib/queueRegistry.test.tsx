import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { APPROVALS_QUEUE_KEYS, APPROVALS_QUEUE_LABELS, QUEUE_REGISTRY } from '@alto-people/shared';
import { I18nProvider, useI18n, type MessageKey } from '@/lib/i18n';

/**
 * One queue registry (F500 SH-4): the Approvals page's chips read the same
 * names the Inbox does (packages/shared queues.ts). Its English `appr.q.*`
 * values are checked against the registry here, so the two pages can't drift.
 */
const KEY: Record<(typeof APPROVALS_QUEUE_KEYS)[number], MessageKey> = {
  'walk-ins': 'appr.q.walkIns',
  'time-off': 'appr.q.timeOff',
  swaps: 'appr.q.swaps',
  pickups: 'appr.q.pickups',
  proposals: 'appr.q.proposals',
  requests: 'appr.q.requests',
  timesheets: 'appr.q.timesheets',
  unconfirmed: 'appr.q.unconfirmed',
};

function Labels() {
  const { t } = useI18n();
  return (
    <ul>
      {APPROVALS_QUEUE_KEYS.map((k) => (
        <li key={k} data-testid={k}>
          {t(KEY[k])}
        </li>
      ))}
    </ul>
  );
}

describe('the queue registry', () => {
  it('the Approvals chips say the registry’s names', () => {
    render(
      <I18nProvider>
        <Labels />
      </I18nProvider>,
    );
    for (const k of APPROVALS_QUEUE_KEYS) expect(screen.getByTestId(k).textContent, k).toBe(APPROVALS_QUEUE_LABELS[k]);
  });

  it('a queue on both pages has one name', () => {
    for (const def of Object.values(QUEUE_REGISTRY)) {
      if (def.approvalsTab === 'requests' || def.approvalsTab === 'proposals') expect(def.label).toBe(APPROVALS_QUEUE_LABELS[def.approvalsTab]);
    }
    expect(QUEUE_REGISTRY['approval-requests']!.label).toBe('Pay & access changes');
    expect(QUEUE_REGISTRY['my-notifications']!.label).toBe('Unread notices');
  });
});
