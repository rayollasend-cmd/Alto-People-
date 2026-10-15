import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { PRODUCT_NAME } from '@alto-people/shared';
import { cn } from '@/lib/cn';

/**
 * The shell every public, no-account page shares: the Trust Center, the
 * status page and the accessibility statement. One header with the
 * product name and the three pages beside a Sign in link, one footer.
 * A prospect reads these before they have an account, so nothing here
 * needs the app's Layout.
 */
const PAGES: Array<{ to: string; label: string }> = [
  { to: '/trust-center', label: 'Trust Center' },
  { to: '/status', label: 'Status' },
  { to: '/accessibility', label: 'Accessibility' },
];

export function PublicShell({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-sunken text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4">
          <Link to="/login" className="font-display text-2xl tracking-tight text-ink">
            {PRODUCT_NAME}
          </Link>
          <nav aria-label="Public pages" className="flex items-center gap-4 text-sm text-ink-muted">
            {PAGES.map((p) => (
              <NavLink key={p.to} to={p.to} className={({ isActive }) => cn('hover:text-ink', isActive && 'text-ink font-medium')} end>
                {p.label}
              </NavLink>
            ))}
            <Link to="/login" className="hover:text-ink">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-8">{children}</main>
      <footer className="border-t border-line">
        <div className="mx-auto max-w-5xl px-4 py-6 text-xs2 text-ink-muted">
          {PRODUCT_NAME} · {eyebrow}
        </div>
      </footer>
    </div>
  );
}
