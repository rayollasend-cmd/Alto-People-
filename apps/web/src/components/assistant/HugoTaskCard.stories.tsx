import type { Meta, StoryObj } from '@storybook/react-vite';
import type { HugoNoteView, HugoTaskView } from '@alto-people/shared';
import { HugoNoteCard } from './HugoNoteCard';
import { HugoTaskCard } from './HugoTaskCard';

const at = (h: number) => new Date(Date.UTC(2026, 9, 29, 15) + h * 3_600_000).toISOString();
const shift = { id: 's1', startsAt: '2026-10-31T11:00:00.000Z', endsAt: '2026-10-31T19:00:00.000Z', timezone: 'America/New_York', site: 'Walmart 1234', position: 'Cashier' };

const base: HugoTaskView = {
  id: 't1',
  kind: 'FIND_COVER',
  status: 'WAITING',
  needs: null,
  choices: [],
  subject: { shift },
  progress: { done: 1, total: 4 },
  result: null,
  linkUrl: '/scheduling',
  source: 'chat',
  seen: true,
  createdAt: at(-2),
  updatedAt: at(-1),
  completedAt: null,
  expiresAt: at(40),
  events: [
    { id: 'e1', code: 'STARTED', data: {}, at: at(-2) },
    { id: 'e2', code: 'ASKED', data: { name: 'Cy D.' }, at: at(-2) },
  ],
};

const meta = {
  title: 'Assistant/Hugo tasks',
  component: HugoTaskCard,
  args: { task: base, busy: null, onRespond: () => {}, onStop: () => {} },
  decorators: [(Story) => <div className="max-w-sm bg-surface p-4">{Story()}</div>],
} satisfies Meta<typeof HugoTaskCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Asking coworkers one at a time: who was asked, how far along. */
export const FindingCover: Story = {};

/** Only the person can decide: the reason in plain words and the answers on offer. */
export const NeedsYou: Story = {
  args: {
    task: {
      ...base,
      status: 'NEEDS_YOU',
      needs: 'NO_ONE_LEFT',
      choices: ['KEEP_TRYING', 'ASK_SUPERVISOR', 'STOP'],
      progress: { done: 3, total: 3 },
      seen: false,
      events: [
        ...base.events,
        { id: 'e3', code: 'DECLINED', data: { name: 'Cy D.' }, at: at(-1.5) },
        { id: 'e4', code: 'ASKED', data: { name: 'Ben M.' }, at: at(-1.5) },
        { id: 'e5', code: 'NO_ANSWER', data: { name: 'Ben M.' }, at: at(-1) },
        { id: 'e6', code: 'NO_ONE_LEFT', data: { asked: 3 }, at: at(-1) },
      ],
    },
  },
};

/** A desk's chase, at the cutoff. */
export const ChaseStillOut: Story = {
  args: {
    task: {
      ...base,
      kind: 'CHASE_CONFIRMATIONS',
      status: 'NEEDS_YOU',
      needs: 'STILL_UNCONFIRMED',
      choices: ['NUDGE_AGAIN', 'GOT_IT'],
      subject: { date: '2026-10-30', shifts: 9 },
      progress: { done: 7, total: 9 },
      result: { unconfirmed: [{ shiftId: 'x', name: 'Ana Lopez', startsAt: at(15), timezone: 'America/New_York', site: 'Walmart 1234' }, { shiftId: 'y', name: 'Ben Moss', startsAt: at(16), timezone: 'America/New_York', site: 'Walmart 1234' }], calledOff: [] },
      events: [
        { id: 'e1', code: 'STARTED', data: {}, at: at(-5) },
        { id: 'e2', code: 'NUDGED', data: { count: 6 }, at: at(-5) },
        { id: 'e3', code: 'STILL_UNCONFIRMED', data: { count: 2 }, at: at(0) },
      ],
    },
  },
};

/** Done, with the paystub one tap away. */
export const PaycheckReady: Story = {
  args: {
    task: {
      ...base,
      kind: 'WATCH_PAYCHECK',
      status: 'DONE',
      subject: {},
      progress: null,
      result: { paycheck: { itemId: 'p1', periodStart: '2026-10-03', periodEnd: '2026-10-16' } },
      linkUrl: '/payroll?item=p1',
      completedAt: at(0),
      events: [
        { id: 'e1', code: 'STARTED', data: {}, at: at(-48) },
        { id: 'e2', code: 'PAID', data: { periodStart: '2026-10-03', periodEnd: '2026-10-16' }, at: at(0) },
      ],
    },
  },
};

const note: HugoNoteView = {
  id: 'n1',
  kind: 'OPEN_SHIFT_MATCH',
  status: 'NEW',
  data: { shift: { ...shift, id: 'os1' }, more: 2 },
  action: { kind: 'link', url: '/marketplace?shift=os1' },
  createdAt: at(0),
};

/** Something Hugo noticed: one tap to act, or put away. */
export const Noticed: Story = {
  render: () => (
    <div className="space-y-2">
      <HugoNoteCard note={note} busy={null} onAccept={() => {}} onDismiss={() => {}} />
      <HugoNoteCard note={{ ...note, id: 'n2', kind: 'CREDENTIAL_EXPIRING', data: { credential: { id: 'c', word: 'ID', name: 'Id — license.jpg', expiresOn: '2026-11-08', days: 10, url: '/documents?renew=d1' } } }} busy={null} onAccept={() => {}} onDismiss={() => {}} />
      <HugoNoteCard note={{ ...note, id: 'n3', kind: 'UNCONFIRMED_TOMORROW', data: { unconfirmed: { date: '2026-10-30', count: 3, total: 9 } } }} busy={null} onAccept={() => {}} onDismiss={() => {}} />
    </div>
  ),
};
