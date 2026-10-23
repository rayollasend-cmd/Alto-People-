import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';

/**
 * Brief 2-3 step 2 — tenant discovery on the login page (decision 1),
 * loaded lazily so the login page's first paint stays in the main budget.
 *
 *   As the person types their email, its domain is asked about (debounced);
 *   a DNS-verified domain answers with its organization's sign-in buttons.
 *   /login/<slug> asks by slug instead, for shared domains. The answer is
 *   the same empty list for an unknown domain, an unverified one and one
 *   without a sign-in, so nothing about accounts or customers leaks.
 */

interface Discovered {
  connections: Array<{ id: string; label: string }>;
}

const domainOf = (email: string) => {
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]{2,})$/.exec(email.trim().toLowerCase());
  return m ? m[1]! : null;
};

export default function SsoDiscovery({ email, slug, from, disabled }: { email: string; slug: string | null; from: string; disabled: boolean }) {
  const domain = domainOf(email);
  const [debounced, setDebounced] = useState(domain);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(domain), 400);
    return () => clearTimeout(t);
  }, [domain]);

  const q = useQuery({
    queryKey: ['auth', 'sso-discover', slug ?? null, slug ? null : debounced],
    queryFn: () =>
      slug
        ? apiFetch<Discovered>(`/auth/oidc/tenant/${encodeURIComponent(slug)}`)
        : apiFetch<Discovered>(`/auth/oidc/discover?email=${encodeURIComponent(`x@${debounced}`)}`),
    enabled: !!slug || !!debounced,
    retry: false,
    staleTime: 5 * 60_000,
  });

  // The status page is the footer's one link (AuthShell, F500 G5), not a second one here.
  const found = q.data?.connections ?? [];
  if (!found.length) return null;
  return (
    <div className="space-y-3">
      {found.map((c) => (
        <Button
          key={c.id}
          type="button"
          size="lg"
          variant="outline"
          disabled={disabled}
          className="w-full"
          // A top-level navigation: /start answers a 302 to the IdP.
          onClick={() => window.location.assign(`/api/auth/oidc/start?connection=${c.id}${from === '/' ? '' : `&next=${encodeURIComponent(from)}`}`)}
        >
          <Building2 className="h-4 w-4" />
          {c.label}
        </Button>
      ))}
    </div>
  );
}
