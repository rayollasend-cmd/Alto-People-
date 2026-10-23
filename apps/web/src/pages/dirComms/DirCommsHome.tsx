import { Navigate, useLocation } from 'react-router-dom';

/**
 * /directory — retired. "Directory & comms" was three second homes for
 * things that each have one: the people directory (/people), broadcasts
 * (Notifications › Sends & broadcasts, which opened the same composer) and
 * surveys (/pulse; the Directory's surveys had no way for anyone to answer
 * them). Old links and bookmarks land on the right place:
 *
 *   /directory                               → /people
 *   /directory?tab=broadcasts[&broadcast=id] → /communications?tab=sends&view=broadcasts[&broadcast=id]
 *   /directory?tab=surveys                   → /pulse
 */
export function directoryRedirectTarget(search: string): string {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (tab === 'broadcasts') {
    const next = new URLSearchParams({ tab: 'sends', view: 'broadcasts' });
    const id = params.get('broadcast');
    if (id) next.set('broadcast', id);
    return `/communications?${next.toString()}`;
  }
  if (tab === 'surveys') return '/pulse';
  const q = params.get('q');
  return q ? `/people?${new URLSearchParams({ q }).toString()}` : '/people';
}

export function DirCommsHome() {
  const { search } = useLocation();
  return <Navigate to={directoryRedirectTarget(search)} replace />;
}
