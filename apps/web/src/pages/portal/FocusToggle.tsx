import { useI18n } from '@/lib/i18n';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { focusName, type Focus } from './shiftFocus';

/** My shift ⇄ Whole store. Renders nothing for anyone without a shift. */
export function FocusToggle({
  windows,
  focus,
  onChange,
  className,
}: {
  windows: Array<{ label: string }>;
  focus: Focus;
  onChange: (f: Focus) => void;
  className?: string;
}) {
  const { t } = useI18n();
  if (windows.length === 0) return null;
  return (
    <SegmentedControl<Focus>
      className={className}
      ariaLabel={t('focus.aria')}
      value={focus}
      onChange={onChange}
      options={[
        {
          value: 'mine',
          label: (
            <span>
              {t('focus.myShift')}{' '}
              <span className="opacity-70">· {focusName(windows)}</span>
            </span>
          ),
        },
        { value: 'store', label: t('focus.wholeStore') },
      ]}
    />
  );
}
