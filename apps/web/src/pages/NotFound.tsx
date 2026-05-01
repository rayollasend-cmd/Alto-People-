import { Link, useLocation } from 'react-router-dom';
import { Compass, Home } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-5">
        <div className="mx-auto h-14 w-14 rounded-full bg-navy-secondary border border-navy-secondary grid place-items-center">
          <Compass className="h-7 w-7 text-silver" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h1 className="font-display text-2xl text-white">Page not found</h1>
          <p className="text-sm text-silver">
            Nothing lives at <span className="font-mono text-silver/90">{pathname}</span>.
            It may have moved, or the link could be out of date.
          </p>
        </div>
        <div className="flex justify-center">
          <Button asChild>
            <Link to="/">
              <Home className="h-4 w-4" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
