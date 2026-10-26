import type { Meta, StoryObj } from '@storybook/react-vite';
import { HugoMascot, type HugoPose } from './HugoMascot';

const meta = {
  title: 'Brand/Hugo',
  component: HugoMascot,
  args: { pose: 'hello', size: 160 },
} satisfies Meta<typeof HugoMascot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Hello: Story = {};

const POSES: Array<[HugoPose, string]> = [
  ['hello', 'Say hi · not working'],
  ['working', 'Working · typing'],
  ['listening', 'Listening'],
  ['thinking', 'Thinking'],
  ['reading', 'Reading a document'],
  ['pointing', 'Pointing'],
  ['handoff', 'Handing you to a person'],
  ['celebrate', 'Celebrating'],
  ['coffee', 'Coffee break'],
  ['offline', 'Offline · reconnecting'],
  ['face', 'Face (buttons, avatars)'],
];

/** Every pose: headphones on when he's working, around his neck when he isn't, greyed out offline. */
export const AllPoses: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {POSES.map(([pose, label]) => (
        <figure key={pose} className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface p-3">
          <HugoMascot pose={pose} size={pose === 'face' ? 96 : 128} />
          <figcaption className="text-xs text-ink-muted">{label}</figcaption>
        </figure>
      ))}
    </div>
  ),
};

/** The sizes the app uses: the top bar (26), the panel header (36), typing (40), the home card (56), the panel (112). */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4">
      <HugoMascot pose="face" size={26} play="still" />
      <HugoMascot pose="face" size={36} />
      <HugoMascot pose="working" size={40} />
      <HugoMascot pose="hello" size={56} />
      <HugoMascot pose="hello" size={112} />
    </div>
  ),
};
