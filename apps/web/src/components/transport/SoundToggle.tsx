import { Volume2, VolumeX } from 'lucide-react';
import { useRideSounds } from '@/lib/rideAlerts';
import { Button } from '@/components/ui/Button';

/** The mute switch for ride sounds on this device. */
export function SoundToggle({ onLabel, offLabel }: { onLabel: string; offLabel: string }) {
  const [on, setOn] = useRideSounds();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={on ? onLabel : offLabel}
      aria-pressed={on}
      title={on ? onLabel : offLabel}
      onClick={() => setOn(!on)}
    >
      {on ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
    </Button>
  );
}
