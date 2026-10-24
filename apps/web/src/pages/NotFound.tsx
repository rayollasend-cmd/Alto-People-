import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, Home, Search } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { usePageHero } from '@/lib/pageTitle';

/** The palette listens for ⌘K / Ctrl+K on the window (components/ui/CommandPalette). */
function openSearch() {
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: mac, ctrlKey: !mac, bubbles: true }));
}

export function NotFound() {
  const navigate = useNavigate();
  // The top bar names the page ("Page not found"), not the product.
  const hero = usePageHero<HTMLHeadingElement>('Page not found');
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
            We couldn&rsquo;t find that page
          </h1>
          <p className="text-sm text-silver">It may have moved, or the link could be out of date. Search for it, or start again from home.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {canGoBack && (
            <Button variant="outline" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Go back
            </Button>
          )}
          <Button variant="outline" onClick={openSearch}>
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="h-4 w-4" aria-hidden="true" />
              Go home
            </Link>
          </Button>
        </div>
        <p className="hidden text-xs text-ink-muted sm:block">
          Or press <kbd className="rounded border border-line px-1 font-sans">⌘K</kbd> anywhere to search.
        </p>
      </div>
    </div>
  );
}
