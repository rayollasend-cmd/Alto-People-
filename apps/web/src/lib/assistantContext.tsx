import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HugoSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getHugo, getHugoSummary, type AssistantPage, type HugoMe } from '@/lib/hugoApi';
import { onLiveEvent } from '@/lib/liveEvents';
import { usePageTitle } from '@/lib/pageTitle';

/**
 * The assistant, as one thing in the app.
 *
 * One pane, one conversation, wherever the person is: the top bar's spark,
 * ⌘J, the seat on a home, the phone menu and the palette all open the same
 * pane with the same thread. The pane knows the page — the route and its
 * title from the chrome, and the record a page names through
 * `useAssistantRecord` — and sends that with every question, so "this
 * person" means the person on screen.
 *
 * Outside the provider (a test rendering one component) `useAssistant`
 * returns an inert value: the seat then answers in place, as it did.
 *
 * Hugo also works in the background (lib/hugoApi tasks and notes): the
 * pane's Tasks tab, the badge on every way in (`summary`), and a link any
 * notice can carry — `?hugo=tasks`, `?hugo=task:<id>`, `?hugo=notes`,
 * `?hugo=chat` opens the pane there on whatever page it lands (a
 * notification URL contract: keep these working).
 */

export type AssistantTab = 'chat' | 'tasks';

export interface AssistantRecord {
  type: string;
  id: string;
  name: string;
}

export interface AssistantValue {
  /** True inside the provider. */
  mounted: boolean;
  /** The assistant serves this account (the API answered GET /hugo). */
  available: boolean;
  me: HugoMe | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open the pane and ask this right away. */
  ask: (text: string) => void;
  /** A question queued by `ask`, consumed once by the pane. */
  takeQueued: () => string | null;
  page: AssistantPage;
  setRecord: (record: AssistantRecord | null) => void;
  tab: AssistantTab;
  setTab: (tab: AssistantTab) => void;
  /** Open the pane on its Tasks tab, with this task opened up. */
  openTasks: (taskId?: string | null) => void;
  /** The task a link or a card asked to show; the tab scrolls to it once. */
  focusTaskId: string | null;
  clearFocus: () => void;
  /** What Hugo is doing in the background — the badge. Null until known. */
  summary: HugoSummary | null;
}

const INERT: AssistantValue = {
  mounted: false,
  available: false,
  me: null,
  open: false,
  setOpen: () => {},
  toggle: () => {},
  ask: () => {},
  takeQueued: () => null,
  page: { path: '/' },
  setRecord: () => {},
  tab: 'chat',
  setTab: () => {},
  openTasks: () => {},
  focusTaskId: null,
  clearFocus: () => {},
  summary: null,
};

const AssistantContext = createContext<AssistantValue>(INERT);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const title = usePageTitle();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<AssistantTab>('chat');
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [record, setRecord] = useState<AssistantRecord | null>(null);
  const queued = useRef<string | null>(null);
  const [queueTick, setQueueTick] = useState(0);

  // One request tells us whether this account has an assistant at all
  // (403: nothing for this role; 409: switched off) and what to call it.
  const me = useQuery({
    queryKey: ['hugo', 'me'],
    queryFn: getHugo,
    // A client account has no assistant: don't ask (a refused GET /hugo on every page load — F500 G5).
    enabled: Boolean(user) && user?.role !== 'CLIENT_PORTAL',
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 409)) && count < 1,
    // A 403/409 is the answer for this account; a page that mounts the pane
    // or the home seat must not ask again (the client portal sent a refused
    // GET /hugo on every page).
    retryOnMount: false,
  });
  const available = Boolean(user) && !me.isError && Boolean(me.data);

  // The badge: what Hugo has for the person. Polled gently; a live nudge
  // (a task stepped, a note came) refetches it and the Tasks tab at once.
  const summary = useQuery({
    queryKey: ['hugo', 'summary'],
    queryFn: getHugoSummary,
    enabled: available,
    refetchInterval: 90_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    if (!available) return;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: ['hugo'], predicate: (q) => q.queryKey[1] !== 'me' });
    const offHugo = onLiveEvent('hugo', refresh);
    // A notice from Hugo lands as a notification too.
    const offBell = onLiveEvent('notification', () => void queryClient.invalidateQueries({ queryKey: ['hugo', 'summary'] }));
    return () => {
      offHugo();
      offBell();
    };
  }, [available, queryClient]);

  // ?hugo=tasks | task:<id> | notes | chat — open the pane there, then drop the parameter.
  const hugoParam = new URLSearchParams(location.search).get('hugo');
  useEffect(() => {
    if (!hugoParam || !available) return;
    if (hugoParam === 'chat') setTab('chat');
    else {
      setTab('tasks');
      const m = /^task:([0-9a-f-]{36})$/i.exec(hugoParam);
      setFocusTaskId(m ? m[1]! : null);
    }
    setOpen(true);
    const next = new URLSearchParams(location.search);
    next.delete('hugo');
    const qs = next.toString();
    navigate({ pathname: location.pathname, search: qs ? `?${qs}` : '', hash: location.hash }, { replace: true });
    // Once per link: the parameter is gone after this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hugoParam, available]);

  // A record belongs to the page that named it; leaving the page drops it.
  useEffect(() => {
    setRecord(null);
  }, [location.pathname]);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  const ask = useCallback((text: string) => {
    queued.current = text;
    setTab('chat');
    setOpen(true);
    setQueueTick((t) => t + 1);
  }, []);
  const openTasks = useCallback((taskId?: string | null) => {
    setTab('tasks');
    setFocusTaskId(taskId ?? null);
    setOpen(true);
  }, []);
  const clearFocus = useCallback(() => setFocusTaskId(null), []);
  const takeQueued = useCallback(() => {
    const q = queued.current;
    queued.current = null;
    return q;
  }, []);

  // ⌘J / Ctrl+J opens or closes the pane, like the spark in the top bar.
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available, toggle]);

  const page = useMemo<AssistantPage>(
    () => ({ path: location.pathname + location.search, title: title ?? null, record }),
    [location.pathname, location.search, title, record],
  );

  const value = useMemo<AssistantValue>(
    () => ({
      mounted: true,
      available,
      me: me.data ?? null,
      open: open && available,
      setOpen,
      toggle,
      ask,
      takeQueued,
      page,
      setRecord,
      tab,
      setTab,
      openTasks,
      focusTaskId,
      clearFocus,
      summary: summary.data ?? null,
    }),
    // queueTick is in the list so a repeated `ask` of the same text re-renders the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [available, me.data, open, toggle, ask, takeQueued, page, queueTick, tab, openTasks, focusTaskId, clearFocus, summary.data],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant(): AssistantValue {
  return useContext(AssistantContext);
}

/** A page names the record it shows, so the assistant knows what "this" means. */
export function useAssistantRecord(record: AssistantRecord | null): void {
  const { setRecord, mounted } = useAssistant();
  const key = record ? `${record.type}:${record.id}:${record.name}` : '';
  useEffect(() => {
    if (!mounted) return;
    setRecord(record);
    return () => setRecord(null);
    // The record is keyed by its identity, not its object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, key]);
}
