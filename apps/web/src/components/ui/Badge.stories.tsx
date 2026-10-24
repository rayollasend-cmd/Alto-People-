import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Badge } from './Badge';

const meta = {
  title: 'Kit/Badge',
  component: Badge,
  args: { children: 'Approved', variant: 'success' },
  argTypes: {
    variant: { control: 'select', options: ['default', 'success', 'pending', 'destructive', 'accent', 'info', 'outline'] },
    size: { control: 'inline-radio', options: ['sm', 'default', 'lg'] },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Every status colour, at every size — the status contract in one place. */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {(['sm', 'default', 'lg'] as const).map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-2">
          <Badge size={size}>Draft</Badge>
          <Badge size={size} variant="success">Active</Badge>
          <Badge size={size} variant="pending">Waiting for approval</Badge>
          <Badge size={size} variant="destructive">Rejected</Badge>
          <Badge size={size} variant="accent">In progress</Badge>
          <Badge size={size} variant="info">Out today</Badge>
          <Badge size={size} variant="outline">Seasonal</Badge>
        </div>
      ))}
    </div>
  ),
};

/** A long label truncates with its whole text as the tooltip. */
export const LongLabel: Story = {
  args: { children: 'Waiting on the second approver in payroll', variant: 'pending' },
  render: (args) => (
    <div className="w-40">
      <Badge {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const badge = within(canvasElement).getByTitle('Waiting on the second approver in payroll');
    await expect(badge).toBeInTheDocument();
  },
};

export const Caps: Story = { args: { children: 'New', variant: 'accent', caps: true } };
