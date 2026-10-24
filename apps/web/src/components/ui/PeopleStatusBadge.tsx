import { WORK_STATUSES, WORK_STATUS_LABELS, type DirectoryStatus, type WorkStatus } from '@alto-people/shared';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { BadgeVariant } from '@/lib/status';
import '@/lib/i18n/en/people';

/**
 * Where a person stands, in the one vocabulary every page uses (Fortune 500
 * fix-up, SH-4; the rule is apps/api/src/lib/peopleStatus.ts):
 *
 *   Working · No recent shifts · Not placed · Onboarding · Paused · Separated
 *
 * The People directory, a person's record, the Workforce roster and
 * Headcount render a person's status through this badge, so the same
 * person never reads "Inactive" on one page and "Active" on the next. The
 * badge's title says what the word means.
 */
export const WORK_STATUS_TONE: Readonly<Record<WorkStatus, BadgeVariant>> = {
  ACTIVE: 'success',
  PLACED_NOT_ACTIVE: 'pending',
  NOT_PLACED: 'default',
  ONBOARDING: 'accent',
  DEACTIVATED: 'outline',
  SEPARATED: 'outline',
};

const LABEL_KEY: Readonly<Record<WorkStatus, MessageKey>> = {
  ACTIVE: 'people.ws.ACTIVE',
  PLACED_NOT_ACTIVE: 'people.ws.PLACED_NOT_ACTIVE',
  NOT_PLACED: 'people.ws.NOT_PLACED',
  ONBOARDING: 'people.ws.ONBOARDING',
  DEACTIVATED: 'people.ws.DEACTIVATED',
  SEPARATED: 'people.ws.SEPARATED',
};

const DEF_KEY: Readonly<Record<WorkStatus, MessageKey>> = {
  ACTIVE: 'people.wsDef.ACTIVE',
  PLACED_NOT_ACTIVE: 'people.wsDef.PLACED_NOT_ACTIVE',
  NOT_PLACED: 'people.wsDef.NOT_PLACED',
  ONBOARDING: 'people.wsDef.ONBOARDING',
  DEACTIVATED: 'people.wsDef.DEACTIVATED',
  SEPARATED: 'people.wsDef.SEPARATED',
};

/** The i18n keys for a status's word and its definition (for tiles and filter chips). */
export function workStatusKeys(s: WorkStatus): { label: MessageKey; definition: MessageKey } {
  return { label: LABEL_KEY[s], definition: DEF_KEY[s] };
}

/**
 * A row's work status, from an older API that sent only the three-word
 * status: ACTIVE and PENDING map exactly; INACTIVE can't be split, so it
 * reads as "No recent shifts" only when nothing better is known.
 */
export function workStatusOf(row: { workStatus?: WorkStatus | null; status?: DirectoryStatus | null; separatedAt?: string | null; deactivatedAt?: string | null }): WorkStatus {
  if (isWorkStatus(row.workStatus)) return row.workStatus;
  if (row.separatedAt) return 'SEPARATED';
  if (row.deactivatedAt) return 'DEACTIVATED';
  if (row.status === 'ACTIVE') return 'ACTIVE';
  if (row.status === 'PENDING') return 'ONBOARDING';
  return 'PLACED_NOT_ACTIVE';
}

/** Whether a value is one of the six statuses (a row from an older or odd response may carry anything). */
export function isWorkStatus(v: unknown): v is WorkStatus {
  return typeof v === 'string' && (WORK_STATUSES as readonly string[]).includes(v);
}

/** English word for sorting and CSV, where no hook is at hand. */
export function workStatusEnglish(s: WorkStatus): string {
  return WORK_STATUS_LABELS[s] ?? '';
}

export interface PeopleStatusBadgeProps extends Omit<BadgeProps, 'variant' | 'children'> {
  status: WorkStatus;
  /** The active window in days, for the definition ("worked in the last 14 days"). */
  windowDays?: number;
}

export function PeopleStatusBadge({ status: given, windowDays = 14, title, ...rest }: PeopleStatusBadgeProps) {
  const { t } = useI18n();
  const status: WorkStatus = isWorkStatus(given) ? given : 'NOT_PLACED';
  return (
    <Badge variant={WORK_STATUS_TONE[status]} title={title ?? t(DEF_KEY[status], { days: windowDays })} data-work-status={status} {...rest}>
      {t(LABEL_KEY[status])}
    </Badge>
  );
}
