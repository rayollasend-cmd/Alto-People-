import type { Meta, StoryObj } from '@storybook/react-vite';
import { Avatar, type AvatarSize } from './Avatar';

// A drawn portrait as a data URI: the story never fetches a photo.
const PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#5b7fa6"/><circle cx="32" cy="25" r="12" fill="#e9d3b8"/><rect x="12" y="42" width="40" height="30" rx="15" fill="#e9d3b8"/></svg>',
  );

const SIZES: AvatarSize[] = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

const meta = {
  title: 'Kit/Avatar',
  component: Avatar,
  args: { name: 'Maria Lopez', email: 'maria.lopez@example.com', size: 'lg' },
  argTypes: { size: { control: 'inline-radio', options: SIZES } },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No photo: initials on a colour picked from the name. */
export const Initials: Story = {};

export const Photo: Story = { args: { src: PHOTO } };

export const Ringed: Story = { args: { src: PHOTO, ringed: true } };

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-end gap-3">
      {SIZES.map((size) => (
        <Avatar key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

/** Many people, many colours — the initials stay readable on each. */
export const Team: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {['Maria Lopez', 'Dana Reyes', 'Luis Okafor', 'Aisha Nguyen', 'Tomás Haddad', 'Priya Kowalczyk', 'Kwame Bianchi', 'Yuki Santos', 'Olena Ivanenko', 'Grace Park'].map((name) => (
        <Avatar key={name} name={name} size="md" />
      ))}
    </div>
  ),
};

/** No name on file: the initials come from the email's local part. */
export const EmailOnly: Story = { args: { name: null, email: 'ops@altohr.com' } };
