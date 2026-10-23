import { NavLink } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

/**
 * The onboarding desk's three pages as one section (F500 G1): Applications
 * | Templates | Analytics, a strip of links under the title. They used to
 * be "Analytics" and "Templates" buttons crowding the header beside the
 * real actions. Each keeps its own route (bookmarks, the nav trail); the
 * strip only shows the pages the person can open, and nothing at all when
 * that is just the list.
 */
export function OnboardingSections({ className }: { className?: string }) {
  const { can } = useAuth();
  const links = [
    { to: '/onboarding', label: 'Applications', end: true, show: true },
    // The same capabilities the routes ask for (App.tsx).
    { to: '/onboarding/templates', label: 'Templates', end: false, show: can('view:hr-admin') && can('manage:onboarding') },
    { to: '/onboarding/analytics', label: 'Analytics', end: false, show: can('view:analytics') },
  ].filter((l) => l.show);
  if (links.length < 2) return null;
  return (
    <nav aria-label="Onboarding" className={cn('flex flex-nowrap gap-1 overflow-x-auto border-b border-navy-secondary scrollbar-none', className)}>
      {links.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.end}
          className={({ isActive }) =>
            cn(
              'relative -mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors coarse:min-h-11 coarse:text-base',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
              isActive ? 'border-gold text-gold' : 'border-transparent text-silver hover:text-ink',
            )
          }
        >
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
