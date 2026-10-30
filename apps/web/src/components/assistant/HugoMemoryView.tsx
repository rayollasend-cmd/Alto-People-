import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HUGO_MEMORY_KINDS, HUGO_MEMORY_TEXT_MAX, checkHugoMemoryText, type HugoMemoryKind, type HugoMemoryListResponse, type HugoMemoryRefusal, type HugoMemoryView as Fact } from '@alto-people/shared';
import { ArrowLeft, Briefcase, Bus, CalendarClock, Lock, Pencil, Plus, Star, StickyNote, Trash2, type LucideIcon } from '@/components/ui/icons';
import { HugoMascot } from '@/components/hugo/HugoMascot';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Textarea } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSwitch } from '@/components/settings/SettingsSwitch';
import { ApiError } from '@/lib/api';
import { addHugoMemory, editHugoMemory, forgetAllHugoMemory, getHugoMemory, removeHugoMemory, setHugoMemoryOn } from '@/lib/hugoApi';
import { useI18n, type Lang, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/hugoPane';
import '@/lib/i18n/en/hugoWork';
import { cn } from '@/lib/cn';

/**
 * "What Hugo knows" (Muse phase 4): everything the assistant keeps about
 * the person, in their words — grouped by what it is about, each one
 * changeable and removable, more added by hand, the memory switched off
 * (with one plain sentence about what that means), or all of it forgotten
 * after a confirmation. The same guard the server runs checks a fact as it
 * is typed (packages/shared/src/hugoMemory.ts), so a refusal is said before
 * Save, in the person's language.
 *
 * Opens over the panel (from its ⋯ menu, or the line under the greeting);
 * Back or Escape returns to the chat. Phone first: one column, 44px targets.
 */

const KIND_ICON: Record<HugoMemoryKind, LucideIcon> = {
  PREFERENCE: Star,
  AVAILABILITY: CalendarClock,
  TRAVEL: Bus,
  WORK: Briefcase,
  OTHER: StickyNote,
};

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };
function dayOf(iso: string, lang: Lang): string {
  try {
    return new Intl.DateTimeFormat(LOCALE[lang], { month: 'short', day: 'numeric' }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
  }
}

const refusalOf = (err: unknown): HugoMemoryRefusal | null => {
  if (!(err instanceof ApiError)) return null;
  const r = (err.details as { reason?: HugoMemoryRefusal } | undefined)?.reason;
  return r ?? null;
};

export function HugoMemoryView({ name, hugo, onClose }: { name: string; hugo: boolean; onClose: () => void }) {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const memory = useQuery({ queryKey: ['hugo', 'memory'], queryFn: getHugoMemory });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Opened from a menu: the menu hands focus back to its button first, so take it a frame later.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => backRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  const failed = (err: unknown) => {
    const reason = refusalOf(err);
    setError(reason ? t(`hugoPane.memory.refused.${reason}` as MessageKey) : t('hugoPane.memory.failed'));
  };
  const put = (next: (d: HugoMemoryListResponse) => HugoMemoryListResponse) =>
    queryClient.setQueryData<HugoMemoryListResponse>(['hugo', 'memory'], (d) => (d ? next(d) : d));

  const add = useMutation({
    mutationFn: ({ text, kind }: { text: string; kind: HugoMemoryKind }) => addHugoMemory(text, kind),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      put((d) => ({ ...d, facts: r.existing ? d.facts : [r.fact, ...d.facts] }));
      setAdding(false);
    },
    onError: failed,
  });
  const edit = useMutation({
    mutationFn: ({ id, text, kind }: { id: string; text: string; kind: HugoMemoryKind }) => editHugoMemory(id, { text, kind }),
    onMutate: () => setError(null),
    onSuccess: (r) => {
      put((d) => ({ ...d, facts: d.facts.map((f) => (f.id === r.fact.id ? r.fact : f)) }));
      setEditingId(null);
    },
    onError: failed,
  });
  const remove = useMutation({
    mutationFn: (fact: Fact) => removeHugoMemory(fact.id),
    onMutate: () => setError(null),
    onSuccess: (_r, fact) => {
      put((d) => ({ ...d, facts: d.facts.filter((f) => f.id !== fact.id) }));
      setSaid(t('hugoPane.memory.undone'));
    },
    onError: failed,
  });
  const forgetAll = useMutation({
    mutationFn: forgetAllHugoMemory,
    onMutate: () => setError(null),
    onSuccess: () => {
      put((d) => ({ ...d, facts: [] }));
      setConfirmForget(false);
      setSaid(t('hugoPane.memory.forgot', { name }));
    },
    onError: (err) => {
      setConfirmForget(false);
      failed(err);
    },
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => setHugoMemoryOn(on),
    onMutate: (on) => {
      setError(null);
      put((d) => ({ ...d, memoryOn: on }));
    },
    onError: (err, on) => {
      put((d) => ({ ...d, memoryOn: !on }));
      failed(err);
    },
  });

  const facts = useMemo(() => memory.data?.facts ?? [], [memory.data]);
  const groups = useMemo(() => HUGO_MEMORY_KINDS.map((kind) => ({ kind, facts: facts.filter((f) => f.kind === kind) })).filter((g) => g.facts.length), [facts]);
  const on = memory.data?.memoryOn ?? true;
  const max = memory.data?.max ?? 50;
  const full = facts.length >= max;

  return (
    <section
      aria-labelledby={titleId}
      data-testid="hugo-memory"
      className="absolute inset-0 z-10 flex flex-col bg-surface text-ink"
      onKeyDown={(e) => {
        // Escape goes back to the chat, not out of the panel.
        if (e.key === 'Escape' && !confirmForget) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Button ref={backRef} variant="ghost" size="icon" onClick={onClose} aria-label={t('hugoPane.memory.back')}>
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Button>
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold">
          {t('hugoPane.memory.title', { name })}
        </h2>
        {memory.data && (
          <span className="shrink-0 pr-2 text-xs tabular-nums text-ink-muted" data-testid="hugo-memory-count">
            {t('hugoPane.memory.count', { count: facts.length, max })}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4">
        <p className="flex items-start gap-2 text-sm leading-relaxed text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-positive" aria-hidden="true" />
          {t('hugoPane.memory.intro', { name })}
        </p>

        {/* The switch, and what it means — in one sentence. */}
        <div className="rounded-xl border border-line bg-surface-raised p-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`${titleId}-on`} className="text-sm font-medium text-ink">
              {t('hugoPane.memory.switch', { name })}
            </label>
            <SettingsSwitch id={`${titleId}-on`} checked={on} disabled={!memory.data || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-describedby={`${titleId}-means`} />
          </div>
          <p id={`${titleId}-means`} className="mt-1.5 text-xs leading-relaxed text-ink-muted">
            {t(on ? 'hugoPane.memory.on' : 'hugoPane.memory.off', { name })}
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-negative/40 bg-negative/10 px-3 py-2 text-sm text-ink">
            {error}
          </p>
        )}
        <p role="status" className="sr-only">
          {said}
        </p>

        {memory.isLoading ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : memory.isError ? (
          <div className="space-y-3 text-center" role="alert">
            <p className="text-sm text-ink-muted">{t('hugoPane.memory.failed')}</p>
            <Button size="sm" variant="outline" onClick={() => void memory.refetch()}>
              {t('hugoWork.retry')}
            </Button>
          </div>
        ) : (
          <>
            {adding ? (
              <MemoryForm
                busy={add.isPending}
                onSave={(text, kind) => add.mutate({ text, kind })}
                onCancel={() => {
                  setAdding(false);
                  setError(null);
                }}
              />
            ) : (
              on && (
                <Button
                  variant="secondary"
                  className="w-full justify-start"
                  disabled={full}
                  onClick={() => {
                    setEditingId(null);
                    setAdding(true);
                  }}
                  data-testid="hugo-memory-add"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('hugoPane.memory.add')}
                </Button>
              )
            )}
            {on && full && !adding && <p className="text-xs text-ink-muted">{t('hugoPane.memory.refused.FULL')}</p>}

            {facts.length === 0 && !adding && (
              <div className="flex flex-col items-center gap-2 pt-2 text-center">
                {hugo && <HugoMascot pose="reading" size={96} />}
                <p className="max-w-[32ch] text-sm leading-relaxed text-ink-muted">{t('hugoPane.memory.empty', { name })}</p>
              </div>
            )}

            {groups.map(({ kind, facts: list }) => {
              const Icon = KIND_ICON[kind];
              return (
                <section key={kind} aria-labelledby={`${titleId}-${kind}`}>
                  <h3 id={`${titleId}-${kind}`} className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {t(`hugoPane.memory.kind.${kind}` as MessageKey)}
                  </h3>
                  <ul className="space-y-2">
                    {list.map((f) =>
                      editingId === f.id ? (
                        <li key={f.id}>
                          <MemoryForm
                            initial={f}
                            busy={edit.isPending}
                            onSave={(text, k) => edit.mutate({ id: f.id, text, kind: k })}
                            onCancel={() => {
                              setEditingId(null);
                              setError(null);
                            }}
                          />
                        </li>
                      ) : (
                        <li key={f.id} className="flex items-start gap-1 rounded-xl border border-line bg-surface-raised py-1.5 pl-3 pr-1" data-testid="hugo-memory-fact">
                          <div className="min-w-0 flex-1 py-1">
                            <p className="break-words text-sm text-ink">{f.text}</p>
                            <p className="mt-0.5 text-xs text-ink-muted">
                              {f.source === 'TOLD' ? t('hugoPane.memory.told', { name, date: dayOf(f.createdAt, lang) }) : t('hugoPane.memory.added', { date: dayOf(f.createdAt, lang) })}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('hugoPane.memory.edit', { text: f.text })}
                            onClick={() => {
                              setAdding(false);
                              setError(null);
                              setEditingId(f.id);
                            }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('hugoPane.memory.remove', { text: f.text })}
                            loading={remove.isPending && remove.variables?.id === f.id}
                            onClick={() => remove.mutate(f)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </li>
                      ),
                    )}
                  </ul>
                </section>
              );
            })}

            {facts.length > 0 && (
              <div className="border-t border-line pt-4">
                <Button variant="ghost" className="w-full text-negative hover:text-negative" onClick={() => setConfirmForget(true)} data-testid="hugo-memory-forget-all">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('hugoPane.memory.forgetAll')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmForget}
        onOpenChange={setConfirmForget}
        title={t('hugoPane.memory.forgetTitle', { name })}
        description={t('hugoPane.memory.forgetBody', { name, count: facts.length })}
        confirmLabel={t('hugoPane.memory.forgetAll')}
        destructive
        busy={forgetAll.isPending}
        onConfirm={() => forgetAll.mutate()}
      />
    </section>
  );
}

/**
 * Add or change one fact: the words (200 at most, the guard checking them
 * as they are typed) and what it is about.
 */
function MemoryForm({ initial, busy, onSave, onCancel }: { initial?: Fact; busy: boolean; onSave: (text: string, kind: HugoMemoryKind) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(initial?.text ?? '');
  const [kind, setKind] = useState<HugoMemoryKind>(initial?.kind ?? 'PREFERENCE');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const check = text.trim() ? checkHugoMemoryText(text) : null;
  const refusal = check && !check.ok ? check.reason : null;
  const ready = Boolean(check?.ok) && !busy;

  return (
    <form
      className="space-y-3 rounded-xl border border-accent/50 bg-surface-raised p-3"
      data-testid="hugo-memory-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (check?.ok) onSave(check.text, kind);
      }}
    >
      <div>
        <label htmlFor={`${id}-text`} className="mb-1 block text-sm font-medium text-ink">
          {t('hugoPane.memory.field')}
        </label>
        <Textarea
          ref={ref}
          id={`${id}-text`}
          value={text}
          rows={2}
          maxLength={HUGO_MEMORY_TEXT_MAX}
          placeholder={t('hugoPane.memory.placeholder')}
          aria-invalid={refusal ? true : undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => setText(e.target.value)}
          className="resize-none coarse:text-base"
        />
        <div id={`${id}-help`} className="mt-1 flex items-start justify-between gap-2 text-xs">
          <span className={cn(refusal ? 'text-negative' : 'text-ink-muted')} role={refusal ? 'alert' : undefined}>
            {refusal ? t(`hugoPane.memory.refused.${refusal}` as MessageKey) : null}
          </span>
          <span className="shrink-0 tabular-nums text-ink-muted" aria-hidden="true">
            {text.length}/{HUGO_MEMORY_TEXT_MAX}
          </span>
        </div>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-ink">{t('hugoPane.memory.kindLabel')}</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup">
          {HUGO_MEMORY_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            const picked = k === kind;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={picked}
                onClick={() => setKind(k)}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors coarse:min-h-11',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  picked ? 'border-accent bg-accent-fill/15 text-ink' : 'border-line text-ink-muted hover:border-accent/60 hover:text-ink',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(`hugoPane.memory.kind.${k}` as MessageKey)}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('hugoPane.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!ready} loading={busy}>
          {t('hugoPane.memory.save')}
        </Button>
      </div>
    </form>
  );
}
