import type { Meta, StoryObj } from '@storybook/react-vite';
import { CalendarDays, Inbox } from '@/components/ui/icons';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { EmptyState } from './EmptyState';

const meta = {
  title: 'Kit/EmptyState',
  component: EmptyState,
  args: {
    icon: CalendarDays,
    title: 'No shifts this week',
    description: 'Publish the schedule to see who works when.',
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** With the action that takes the next step. */
export const WithAction: Story = {
  args: { action: <Button size="sm">Open the planner</Button> },
};

/** One quiet line inside a section: no heading, no wasted height. */
export const Small: Story = {
  args: { size: 'sm', icon: Inbox, title: 'Nothing waiting on you', description: undefined },
  render: (args) => (
    <Card className="max-w-md">
      <CardContent className="py-4">
        <EmptyState {...args} />
      </CardContent>
    </Card>
  ),
};
