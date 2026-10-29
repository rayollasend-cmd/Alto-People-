import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, Home, Search } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { usePageHero } from '@/lib/pageTitle';
import { useI18n } from '@/lib/i18n';

/** The palette listens for ⌘K / Ctrl+K on the window (components/ui/CommandPalette). */
function openSearch() {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: mac, ctrlKey: !mac, bubbles: true }));
}

export function NotFound() {
  const navigate = useNavigate();
  const { t } = useI18n();
  // The top bar names the page ("Page not found"), not the product.
  const hero = usePageHero<HTMLHeadingElement>(t('error.pageNotFound'));
  const [pressBefore, pressAfter] = t('error.pressToSearch').split('{key}');
  // A first page in the tab has nowhere to go back to.
  const canGoBack = typeof window !== 'undefined' && window.history.length > 1;
  return (
    <div className="min-h-[60dvh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto h-14 w-14 rounded-full bg-navy-secondary border border-navy-secondary grid place-items-center">
          <Compass className="h-8 w-8 text-silver" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 ref={hero} className="text-2xl text-white">
            {t('error.notFoundTitle')}
          </h1>
          <p className="text-sm text-silver">{t('error.notFoundBody')}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {canGoBack && (
            <Button variant="outline" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('error.goBack')}
            </Button>
          )}
          <Button variant="outline" onClick={openSearch}>
            <Search className="h-4 w-4" aria-hidden="true" />
            {t('error.search')}
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="h-4 w-4" aria-hidden="true" />
              {t('access.home')}
            </Link>
          </Button>
        </div>
        <p className="hidden text-xs text-ink-muted sm:block">
          {pressBefore}<kbd className="rounded border border-line px-1 font-sans">⌘K</kbd>{pressAfter}
        </p>
      </div>
    </div>
  );
}
