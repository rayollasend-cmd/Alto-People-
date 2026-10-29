import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureException } from '@/lib/sentry';
import { ApiError } from '@/lib/api';

/**
 * Top-level error boundary mounted at the React root.
 *
 * Catches errors that propagate out of render / lifecycle / effects of
 * the entire app tree. Without this, an unhandled throw from any page's
 * render path unmounts the whole subtree — the user sees a blank white
 * box and nothing tells us. With this:
 *
 *   - The error is reported to Sentry (no-op if VITE_SENTRY_DSN is
 *     unset).
 *   - The user sees a styled fallback with the requestId (if the error
 *     was an ApiError carrying one) so support can correlate to logs.
 *   - "Try again" reloads the page rather than retrying the broken
 *     subtree — broken subtrees rarely recover from re-render alone.
 *
 * Per-route boundaries (e.g. around individual data widgets) can still
 * sit lower in the tree; this is the last-resort net.
 */
interface State {
  error: Error | null;
}

/**
 * The crash screen's words. This boundary sits OUTSIDE the I18nProvider (it
 * must survive the providers crashing), so it can't call t(); it reads the
 * language the provider last put on <html lang>, like lib/format does.
 */
const CRASH_COPY: Record<string, { title: string; body: string; trace: string; reload: string; back: string }> = {
  en: { title: 'Something broke', body: 'We logged the error and the team has been notified. Refreshing usually fixes it.', trace: 'Trace', reload: 'Reload', back: 'Go back' },
  es: { title: 'Algo falló', body: 'Registramos el error y el equipo ya está avisado. Volver a cargar suele arreglarlo.', trace: 'Rastreo', reload: 'Volver a cargar', back: 'Volver' },
  tr: { title: 'Bir şeyler bozuldu', body: 'Hatayı kaydettik ve ekibe haber verildi. Sayfayı yenilemek genellikle sorunu çözer.', trace: 'İz', reload: 'Yenile', back: 'Geri dön' },
  ht: { title: 'Gen yon bagay ki kase', body: 'Nou anrejistre erè a epi ekip la resevwa avètisman. Rechaje paj la souvan ranje sa.', trace: 'Tras', reload: 'Rechaje', back: 'Tounen' },
  pt: { title: 'Algo deu errado', body: 'Registramos o erro e a equipe já foi avisada. Recarregar a página costuma resolver.', trace: 'Rastreio', reload: 'Recarregar', back: 'Voltar' },
  uk: { title: 'Щось зламалося', body: 'Ми записали помилку, і команда вже знає. Зазвичай допомагає оновити сторінку.', trace: 'Трасування', reload: 'Оновити', back: 'Назад' },
};

function crashCopy() {
  const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'en';
  return CRASH_COPY[lang] ?? CRASH_COPY.en!;
}

export class GlobalErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // captureException no-ops when DSN unset. Component stack is
    // the most useful extra to attach — points at which subtree blew up.
    captureException(error, {
      extra: { componentStack: info.componentStack },
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    const requestId = err instanceof ApiError ? err.requestId : undefined;
    const copy = crashCopy();
    return (
      <div className="min-h-screen flex items-center justify-center bg-midnight p-6">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="text-2xl text-gold">{copy.title}</div>
          <p className="text-sm text-silver">{copy.body}</p>
          {requestId && (
            <p className="text-xs text-silver/70 font-mono">
              {copy.trace}: {requestId}
            </p>
          )}
          <div className="flex justify-center gap-2 pt-2">
            <button
              onClick={() => window.location.reload()}
              className="btn-gold rounded-md px-4 py-2 text-sm font-medium text-navy"
            >
              {copy.reload}
            </button>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.history.back();
              }}
              className="rounded-md border border-navy-secondary px-4 py-2 text-sm text-white hover:bg-navy-secondary/40"
            >
              {copy.back}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
