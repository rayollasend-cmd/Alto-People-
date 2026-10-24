import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import type { AssociatePaySchedule, HirePayStatus, PayScheduleChoicesResponse } from '@alto-people/shared';
import type { ApiMock } from '../../.storybook/mockApi';
import { StartingPayCard } from './StartingPayCard';

/**
 * The onboarding desk's starting-pay card, against a fake API
 * (GET /comp/associates/:id/hire-pay, POST …/records, and the pay-schedule
 * endpoints the application variant reads).
 */

const ASSOCIATE = '00000000-0000-4000-8000-0000000000b7';
const CLIENT = '00000000-0000-4000-8000-0000000000c1';

const NEW_HIRE: HirePayStatus = {
  associateId: ASSOCIATE,
  newHire: true,
  why: 'NEW_HIRE',
  message: null,
  canSet: true,
  compAccess: false,
  startDate: '2026-10-27',
  client: { id: CLIENT, name: 'Coastal Resort' },
  position: 'Housekeeper',
  current: null,
  suggested: { payType: 'HOURLY', amount: '16.50', source: 'OFFER', label: 'The accepted offer: $16.50 an hour' },
  ceilings: {
    HOURLY: { payType: 'HOURLY', amount: '18.00', source: 'RATE_CARD', label: 'the rate card’s pay for Housekeeper at Coastal Resort' },
    SALARY: null,
  },
  pending: null,
};

const ON_FILE: HirePayStatus = {
  ...NEW_HIRE,
  current: { id: '00000000-0000-4000-8000-0000000000d1', payType: 'HOURLY', amount: '16.50', effectiveFrom: '2026-10-27', reason: 'HIRE' },
};

const WAITING: HirePayStatus = {
  ...NEW_HIRE,
  pending: {
    id: '00000000-0000-4000-8000-0000000000e1',
    title: 'Starting pay for Maria Lopez',
    payType: 'HOURLY',
    amount: '19.25',
    effectiveFrom: '2026-10-27',
    requestedAt: '2026-10-22T15:04:00.000Z',
  },
};

const PAST_WINDOW: HirePayStatus = {
  ...ON_FILE,
  newHire: false,
  why: 'PAID',
  message: 'They have been paid on a run, so their pay changes on the Pay tab, by someone with compensation access.',
  canSet: false,
};

const SCHEDULE: AssociatePaySchedule = {
  current: null,
  pending: null,
  ruleDefault: { scheduleId: '00000000-0000-4000-8000-0000000000f1', name: 'Biweekly · Fridays', because: 'Client: Coastal Resort' },
  nextPayDate: '2026-11-06',
  newHire: true,
};

const CHOICES: PayScheduleChoicesResponse = {
  schedules: [
    {
      id: '00000000-0000-4000-8000-0000000000f1',
      name: 'Biweekly · Fridays',
      pattern: 'Every other Friday',
      isActive: true,
      isDefault: true,
      nextPeriod: { periodStart: '2026-10-24', periodEnd: '2026-11-06', payDate: '2026-11-13' },
      firstStart: '2026-10-24',
    },
    {
      id: '00000000-0000-4000-8000-0000000000f2',
      name: 'Weekly · Fridays',
      pattern: 'Every Friday',
      isActive: true,
      isDefault: false,
      nextPeriod: { periodStart: '2026-10-24', periodEnd: '2026-10-30', payDate: '2026-11-06' },
      firstStart: '2026-10-24',
    },
  ],
};

const hirePay = (status: HirePayStatus): ApiMock[] => [
  { path: '/comp/associates/:id/hire-pay', body: status },
  { method: 'POST', path: '/comp/associates/:id/records', body: { ok: true } },
  { path: '/associates/:id/pay-schedule', body: SCHEDULE },
  { path: '/associates/:id/pay-schedule/choices', body: CHOICES },
];

const meta = {
  title: 'Shell/StartingPayCard',
  component: StartingPayCard,
  args: { associateId: ASSOCIATE, variant: 'record' },
  parameters: { auth: { role: 'INTERNAL_RECRUITER' }, api: hirePay(NEW_HIRE) },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StartingPayCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A new hire with nothing on file: the form, prefilled from the accepted offer. */
export const SetStartingPay: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('group', { name: 'Set the starting pay' });
    await expect(within(form).getByRole('radio', { name: 'Hourly' })).toBeChecked();
  },
};

/**
 * Saving at or under the ceiling applies at once.
 *
 * KNOWN FINDING (axe, 2026-10-23): the success toast (sonner's rich
 * colours in the light theme) is 4.25:1, under 4.5:1. The toaster is left
 * out of this story's check until Toaster.tsx sets its own success colours.
 */
export const SaveApplies: Story = {
  parameters: { a11y: { context: { include: ['body'], exclude: ['[data-sonner-toaster]'] } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('group', { name: 'Set the starting pay' });
    const wage = within(form).getByLabelText(/Wage per hour/);
    await userEvent.clear(wage);
    await userEvent.type(wage, '17.25');
    await userEvent.click(within(form).getByRole('button', { name: 'Set starting pay' }));
    await expect(await screen.findByText('Starting pay set.')).toBeInTheDocument();
  },
};

/** Above the rate card's pay: the form says it goes to an approver first. */
export const AboveCeiling: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const form = await canvas.findByRole('group', { name: 'Set the starting pay' });
    const wage = within(form).getByLabelText(/Wage per hour/);
    await userEvent.clear(wage);
    await userEvent.type(wage, '21');
  },
};

export const WageOnFile: Story = {
  parameters: { api: hirePay(ON_FILE) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('$16.50/hr')).toBeInTheDocument();
  },
};

export const WaitingForApproval: Story = {
  parameters: { api: hirePay(WAITING) },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('Waiting for approval')).toBeInTheDocument();
  },
};

/** On the application: the wage, then the schedule the rules chose. */
export const OnTheApplication: Story = {
  args: { variant: 'application' },
};

/** Past the new-hire window, read by someone without compensation access. */
export const PastTheWindow: Story = {
  args: { variant: 'application' },
  parameters: { api: hirePay(PAST_WINDOW) },
};

export const Loading: Story = {
  parameters: { api: [{ path: '/comp/associates/:id/hire-pay', delay: Infinity }] },
};

/** The QueryError inside the card (its "Details for support" contrast is a known finding — see Kit/QueryError). */
export const ServerError: Story = {
  parameters: {
    a11y: { context: { include: ['body'], exclude: ['details > summary'] } },
    api:[{ path: '/comp/associates/:id/hire-pay', status: 500, body: { error: { code: 'internal', message: 'boom', requestId: 'req-31c' } } }] },
};
