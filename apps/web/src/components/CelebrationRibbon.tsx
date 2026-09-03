import { useQuery } from '@tanstack/react-query';
import { PartyPopper } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * "Happy birthday, Maria!" on the one screen an associate opens every
 * day. The server has computed birthdays and anniversaries since Phase
 * 107, but only managers ever saw them — the person being celebrated
 * heard nothing unless a colleague manually sent a high-five.
 */
export function CelebrationRibbon() {
  const { t } = useI18n();
  const { data } = useQuery({
    queryKey: ['me', 'celebration'],
    queryFn: () =>
      apiFetch<{
        birthday: boolean;
        anniversaryYears: number | null;
        firstName: string | null;
      }>('/celebrations/me').catch(() => null),
    // A birthday doesn't change mid-session.
    staleTime: 60 * 60_000,
  });

  if (!data || (!data.birthday && data.anniversaryYears === null)) return null;

  const message = data.birthday
    ? t('dash.happyBirthday', { name: data.firstName ?? '' })
    : t('dash.happyAnniversary', {
        name: data.firstName ?? '',
        years: String(data.anniversaryYears),
      });

  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-3 rounded-lg border border-gold/40 bg-gold/10 px-4 py-3"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gold/20 text-gold">
        <PartyPopper className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-white">{message}</div>
        <div className="text-xs text-silver">{t('dash.celebrationSub')}</div>
      </div>
    </div>
  );
}
