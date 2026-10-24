import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SegmentedControl, type SegmentedControlOption } from './SegmentedControl';

type Window = '7d' | '30d' | '90d' | 'ytd';
const OPTIONS: SegmentedControlOption<Window>[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'ytd', label: 'Year to date' },
];

function Controlled({ options, initial, ariaLabel }: { options: SegmentedControlOption<string>[]; initial: string; ariaLabel: string }) {
  const [value, setValue] = React.useState(initial);
  return <SegmentedControl options={options} value={value} onChange={setValue} ariaLabel={ariaLabel} />;
}

const meta = {
  title: 'Kit/SegmentedControl',
  component: SegmentedControl<Window>,
  args: { options: OPTIONS, value: '30d', onChange: () => undefined, ariaLabel: 'Window' },
} satisfies Meta<typeof SegmentedControl<Window>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Windows: Story = {
  render: (args) => <Controlled options={args.options} initial={args.value} ariaLabel="Window" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: '90 days' }));
    await expect(canvas.getByRole('radio', { name: '90 days' })).toBeChecked();
  },
};

export const WithCounts: Story = {
  render: () => (
    <Controlled
      ariaLabel="Request status"
      initial="pending"
      options={[
        { value: 'pending', label: 'Pending', count: 7 },
        { value: 'approved', label: 'Approved', count: 31 },
        { value: 'denied', label: 'Denied', count: 2 },
      ]}
    />
  ),
};

/** Long labels wrap inside their pill instead of pushing a phone sideways. */
export const LongLabelsOnPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  render: () => (
    <Controlled
      ariaLabel="Invoice style"
      initial="one"
      options={[
        { value: 'one', label: 'One invoice per client, every site together' },
        { value: 'site', label: 'One invoice per site, sent to each manager' },
      ]}
    />
  ),
};
