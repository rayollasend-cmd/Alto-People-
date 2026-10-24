import { Volume2, VolumeX } from '@/components/ui/icons';
import { useRideSounds } from '@/lib/rideAlerts';
import { Button } from '@/components/ui/Button';

/**
 * The mute switch for ride sounds on this device.
 *
 * With `text` it says what it is ("Sounds on") beside the speaker: alone in
 * a page header, an icon-only speaker read as a stray glyph (F500 G2).
 * `onLabel`/`offLabel` stay the full accessible name and tooltip.
 */
export function SoundToggle({
  onLabel,
  offLabel,
  text,
}: {
  onLabel: string;
  offLabel: string;
  /** Visible words for each state, e.g. { on: 'Sounds on', off: 'Sounds off' }. */
  text?: { on: string; off: string };
}) {
  const [on, setOn] = useRideSounds();
  const Icon = on ? Volume2 : VolumeX;
  return (
    <Button
      variant="ghost"
      size={text ? 'sm' : 'icon-sm'}
      aria-label={on ? onLabel : offLabel}
      aria-pressed={on}
      title={on ? onLabel : offLabel}
      onClick={() => setOn(!on)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {text && <span>{on ? text.on : text.off}</span>}
    </Button>
  );
}
