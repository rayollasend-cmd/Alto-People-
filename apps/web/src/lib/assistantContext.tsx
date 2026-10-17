import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getHugo, type AssistantPage, type HugoMe } from '@/lib/hugoApi';
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
 */

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
};

const AssistantContext = createContext<AssistantValue>(INERT);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  const title = usePageTitle();
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<AssistantRecord | null>(null);
  const queued = useRef<string | null>(null);
  const [queueTick, setQueueTick] = useState(0);

  // One request tells us whether this account has an assistant at all
  // (403: nothing for this role; 409: switched off) and what to call it.
  const me = useQuery({
    queryKey: ['hugo', 'me'],
    queryFn: getHugo,
    enabled: Boolean(user),
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 403 || err.status === 409)) && count < 1,
  });
  const available = Boolean(user) && !me.isError && Boolean(me.data);

  // A record belongs to the page that named it; leaving the page drops it.
  useEffect(() => {
    setRecord(null);
  }, [location.pathname]);

  const toggle = useCallback(() => setOpen((o) => !o), []);
  const ask = useCallback((text: string) => {
    queued.current = text;
    setOpen(true);
    setQueueTick((t) => t + 1);
  }, []);
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
    () => ({ mounted: true, available, me: me.data ?? null, open: open && available, setOpen, toggle, ask, takeQueued, page, setRecord }),
    // queueTick is in the list so a repeated `ask` of the same text re-renders the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [available, me.data, open, toggle, ask, takeQueued, page, queueTick],
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
