import { Plus, Trash2 } from '@/components/ui/icons';
import { WORKER_CAPABILITIES, WORK_TASK_RISK_LABELS, type SeasonTaskDemandLine, type SeasonTaskDemandWeek, type SeasonWeekMix } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { fmtMoney } from '@/lib/format';

/**
 * Brief 3-3 — demand as tasks. One list of task lines for the site (a
 * type, how many a week, minutes each, its risk) applied to every week of
 * the season; the planner answers with the people-robot mix per week. A
 * week-by-week task list is the next step when a site's work varies.
 */
export function linesOf(taskDemand: SeasonTaskDemandWeek[]): SeasonTaskDemandLine[] {
  return taskDemand[0]?.tasks ?? [];
}

export function spreadLines(weeks: string[], lines: SeasonTaskDemandLine[]): SeasonTaskDemandWeek[] {
  if (lines.length === 0) return [];
  return weeks.map((week) => ({ week, tasks: lines }));
}

const ROBOT_CAPABILITIES = WORKER_CAPABILITIES.filter((c) => (c.types as readonly string[]).includes('PERSON') || (c.types as readonly string[]).includes('ROBOT'));

export function TaskDemandEditor({
  siteName,
  lines,
  disabled,
  onChange,
}: {
  siteName: string;
  lines: SeasonTaskDemandLine[];
  disabled: boolean;
  onChange: (next: SeasonTaskDemandLine[]) => void;
}) {
  const set = (i: number, patch: Partial<SeasonTaskDemandLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-silver">Work as tasks, per week</span>
        {!disabled && (
          <Button variant="ghost" size="sm" onClick={() => onChange([...lines, { capability: ROBOT_CAPABILITIES[0]?.code ?? 'stocking', count: 50, minutes: 20, risk: 'LOW' }])}>
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> Add a task type
          </Button>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="text-xs text-silver">No tasks yet. Add the kinds of work a week holds and the planner proposes how many robots and people carry it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-silver">
                <th className="py-1 pr-2">Task type</th>
                <th className="py-1 pr-2">Per week</th>
                <th className="py-1 pr-2">Minutes each</th>
                <th className="py-1 pr-2">Risk</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-navy-secondary/60">
                  <td className="py-1 pr-2">
                    <Select aria-label={`${siteName} task ${i + 1} type`} value={l.capability} disabled={disabled} className="h-9 w-48" onChange={(e) => set(i, { capability: e.target.value })}>
                      {ROBOT_CAPABILITIES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.label}
                          {(c.types as readonly string[]).includes('ROBOT') ? '' : ' (people only)'}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Input type="number" inputMode="numeric" min={0} max={100000} aria-label={`${siteName} task ${i + 1} per week`} value={l.count} disabled={disabled} className="h-9 w-24 text-base" onChange={(e) => set(i, { count: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Input type="number" inputMode="numeric" min={0} max={1440} aria-label={`${siteName} task ${i + 1} minutes`} value={l.minutes} disabled={disabled} className="h-9 w-24 text-base" onChange={(e) => set(i, { minutes: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  </td>
                  <td className="py-1 pr-2">
                    <Select aria-label={`${siteName} task ${i + 1} risk`} value={l.risk} disabled={disabled} className="h-9 w-36" onChange={(e) => set(i, { risk: e.target.value as SeasonTaskDemandLine['risk'] })}>
                      {(['LOW', 'MEDIUM', 'HIGH'] as const).map((r) => (
                        <option key={r} value={r}>
                          {WORK_TASK_RISK_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 text-right">
                    {!disabled && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove task ${i + 1}`} onClick={() => onChange(lines.filter((_, j) => j !== i))}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One line under a site: the mix at its peak week, in words. */
export function mixLine(mix: SeasonWeekMix | null | undefined, robotsPlaced: number): string | null {
  if (!mix) return null;
  const robots = mix.robotsNeeded > 0 ? `${mix.robotsNeeded} robot${mix.robotsNeeded === 1 ? '' : 's'} (${robotsPlaced} placed)` : 'no robot work';
  return `${robots} · ${mix.peopleNeeded} people from tasks · backup ${mix.backupCrew} · labor ${fmtMoney(mix.laborCostCents / 100)} · robots ${fmtMoney(mix.robotCostCents / 100)}`;
}
