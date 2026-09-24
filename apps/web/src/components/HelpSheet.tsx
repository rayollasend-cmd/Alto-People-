import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Keyboard, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { helpFor } from '@/lib/help';
import { useI18n } from '@/lib/i18n';
import { searchKb } from '@/lib/kb124Api';
import { seenKey, tourFor } from '@/lib/tours';
import { Button } from '@/components/ui/Button';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';

/**
 * The "?" in the top bar: what this page is for, what you can do here,
 * and the help-center articles that go deeper — in the reader's language,
 * for the route they are on. Pages without an entry get the generic
 * sheet, which still reaches the help center, the shortcuts and What's
 * new, so the button never opens onto nothing.
 */

export function HelpSheet({
  open,
  onOpenChange,
  onShowKeyboardShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowKeyboardShortcuts: () => void;
}) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const location = useLocation();
  const entry = helpFor(location.pathname, lang);
  const tour = tourFor(location.pathname);

  const articles = useQuery({
    queryKey: ['kb', 'help', entry?.kb ?? ''],
    queryFn: () => searchKb({ q: entry!.kb }),
    enabled: open && entry !== null,
    staleTime: 10 * 60 * 1000,
  });

  const replayTour = () => {
    if (!tour || !user) return;
    try {
      window.localStorage.removeItem(seenKey(tour.id, user.id));
    } catch {
      /* best-effort */
    }
    onOpenChange(false);
    // The coach marks re-arm on the next route render; a same-route replay
    // needs a nudge, which a hash change provides without a navigation.
    window.dispatchEvent(new Event('alto:tour-replay'));
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerHeader>
        <DrawerTitle>{entry ? entry.copy.title : t('help.generic')}</DrawerTitle>
        <DrawerDescription>{entry ? entry.copy.intro : t('help.genericIntro')}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-6">
        {entry && (
          <section>
            <h3 className="text-2xs uppercase tracking-widest text-gold">{t('help.youCan')}</h3>
            <ul className="mt-2 space-y-2 text-sm text-silver">
              {entry.copy.actions.map((a) => (
                <li key={a} className="flex gap-2">
                  <span className="text-gold" aria-hidden="true">
                    ·
                  </span>
                  <span className="min-w-0 break-words">{a}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {entry && (
          <section>
            <h3 className="text-2xs uppercase tracking-widest text-gold">{t('help.related')}</h3>
            {articles.isLoading ? (
              <p className="mt-2 text-sm text-silver/70">…</p>
            ) : (articles.data?.articles ?? []).length === 0 ? (
              <p className="mt-2 text-sm text-silver/70">{t('help.noArticles')}</p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                {(articles.data?.articles ?? []).slice(0, 5).map((a) => (
                  <li key={a.id}>
                    <Link
                      to={`/help-center?article=${encodeURIComponent(a.slug)}`}
                      onClick={() => onOpenChange(false)}
                      className="inline-flex items-center gap-1.5 text-gold hover:text-gold-bright hover:underline"
                    >
                      <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 break-words">{a.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section className="space-y-1.5">
          <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
            <Link to="/help-center" onClick={() => onOpenChange(false)}>
              <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('help.openCenter')}
            </Link>
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onShowKeyboardShortcuts}>
            <Keyboard className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('help.shortcuts')}
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
            <Link to="/whats-new" onClick={() => onOpenChange(false)}>
              <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('help.whatsNew')}
            </Link>
          </Button>
        </section>
      </DrawerBody>
      {tour && (
        <DrawerFooter>
          <Button variant="outline" size="sm" onClick={replayTour}>
            {t('help.replayTour')}
          </Button>
        </DrawerFooter>
      )}
    </Drawer>
  );
}
