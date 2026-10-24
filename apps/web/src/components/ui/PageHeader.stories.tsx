import type { Meta, StoryObj } from '@storybook/react-vite';
import { Download, Mail, Printer } from '@/components/ui/icons';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Badge } from './Badge';
import { PageHeader, type PageAction } from './PageHeader';

const ACTIONS: PageAction[] = [
  { label: 'Approve run', primary: true, onSelect: () => undefined },
  { label: 'Export', icon: Download, onSelect: () => undefined },
  { label: 'Email statements', icon: Mail, onSelect: () => undefined },
  { label: 'Print checks', icon: Printer, onSelect: () => undefined },
  { label: 'Void run', destructive: true, confirm: { title: 'Void this run?', description: 'Every check in it is cancelled.' }, onSelect: () => undefined },
];

const meta = {
  title: 'Kit/PageHeader',
  component: PageHeader,
  args: {
    title: 'Payroll run · Oct 3 – Oct 16',
    subtitle: 'Biweekly · pays Oct 23',
    breadcrumbs: [{ label: 'Payroll', to: '/payroll' }],
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TitleOnly: Story = { args: { subtitle: undefined, breadcrumbs: [] } };

/** One primary, two beside it, the rest — and every destructive one — in More. */
export const ActionsAndMore: Story = {
  args: { actions: ACTIONS, status: <Badge variant="pending">In review</Badge> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Approve run' })).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Void run' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /more actions/i }));
    await expect(await screen.findByRole('menuitem', { name: /Void run/ })).toBeInTheDocument();
    // Close it before axe runs: while a Radix menu is open the rest of the
    // page is aria-hidden by design, trigger included.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  },
};

/** The key facts under the title, each linking to the list behind it. */
export const Facts: Story = {
  args: {
    facts: [
      { label: 'Gross', value: '$84,120.00' },
      { label: 'People', value: '212', to: '/payroll/pay-checks?run=r-1' },
      { label: 'Hours', value: '6,480' },
      { label: 'Taxes', value: null, hint: 'Hidden: no number to show' },
    ],
    actions: ACTIONS.slice(0, 2),
  },
};

/** Sibling pages are links, not buttons. */
export const Related: Story = {
  args: {
    related: [
      { label: 'Pay schedules', to: '/payroll/schedules' },
      { label: 'Labor rules', to: '/payroll/labor-rules' },
      { label: 'Tax filings', to: '/payroll/taxes' },
    ],
    actions: ACTIONS.slice(0, 1),
  },
};

export const Everything: Story = {
  args: {
    status: <Badge variant="pending">In review</Badge>,
    facts: [
      { label: 'Gross', value: '$84,120.00' },
      { label: 'People', value: '212', to: '/payroll/pay-checks?run=r-1' },
    ],
    related: [{ label: 'Pay schedules', to: '/payroll/schedules' }],
    actions: ACTIONS,
  },
};

/** On a phone only the primary stays out; the rest open in one sheet. */
export const Phone: Story = {
  ...Everything,
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: /more actions/i }));
    const sheet = await screen.findByRole('dialog');
    await expect(within(sheet).getByRole('button', { name: /Export/ })).toBeInTheDocument();
  },
};

export const LongTitle: Story = {
  args: {
    title: 'Coastal Resort & Spa at Destin Harbor — Housekeeping and Laundry Operations',
    subtitle: 'A client of Alto HR since March 2024 · 4 sites · 212 people working there this week',
    actions: ACTIONS,
  },
};
