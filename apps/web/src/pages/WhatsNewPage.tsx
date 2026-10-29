import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from '@/components/ui/icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/DropdownMenu';
import { toast } from 'sonner';
import { RELEASE_NOTE_AUDIENCES, type ReleaseNote, type ReleaseNoteAudience, type ReleaseNoteInput, type ReleaseNoteItem } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { createReleaseNote, deleteReleaseNote, listReleaseNotes, updateReleaseNote } from '@/lib/releaseNotesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { Skeleton } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/whatsNewPage';
import '@/lib/i18n/en/whatsnew';

/**
 * Every release note, newest first — the history behind the home-screen
 * card — and, for people who can manage the org, the place a note is
 * written. A note is a day and a list of bullets; each bullet names its
 * audience and carries English plus optional Spanish. Publishing is a
 * checkbox: a draft is visible only here, only to editors.
 */

const AUDIENCE_LABEL: Record<ReleaseNoteAudience, MessageKey> = {
  ALL: 'whatsNewPage.audience.all',
  ADMIN: 'whatsNewPage.audience.admin',
  ASSOCIATE: 'whatsNewPage.audience.associate',
  SUPERVISOR: 'whatsNewPage.audience.supervisor',
  DRIVER: 'whatsNewPage.audience.driver',
  CLIENT: 'whatsNewPage.audience.client',
};

const EMPTY_ITEM: ReleaseNoteItem = { audience: 'ALL', en: '', es: null };

type Draft = { id: string | null; day: string; items: ReleaseNoteItem[]; published: boolean };

function draftFrom(note: ReleaseNote | null): Draft {
  return note
    ? { id: note.id, day: note.day, items: note.items.map((i) => ({ ...i })), published: note.publishedAt !== null }
    : { id: null, day: ymdLocal(), items: [{ ...EMPTY_ITEM }], published: false };
}

export function WhatsNewPage() {
  const { t, lang } = useI18n();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const notes = useQuery({ queryKey: ['release-notes', 'list'], queryFn: () => listReleaseNotes(50) });
  const [draft, setDraft] = useState<Draft | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['release-notes'] });
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const input: ReleaseNoteInput = {
        day: d.day,
        items: d.items.map((i) => ({ audience: i.audience, en: i.en.trim(), es: i.es?.trim() ? i.es.trim() : null })),
        published: d.published,
      };
      return d.id ? updateReleaseNote(d.id, input) : createReleaseNote(input);
    },
    onSuccess: (_r, d) => {
      toast.success(d.published ? t('whatsNewPage.publishedToast') : t('whatsNewPage.draftSavedToast'));
      setDraft(null);
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('whatsNewPage.saveFailed')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteReleaseNote(id),
    onSuccess: () => {
      toast.success(t('whatsNewPage.deletedToast'));
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('whatsNewPage.deleteFailed')),
  });

  const canEdit = notes.data?.canEdit ?? false;
  const text = (i: ReleaseNoteItem) => (lang === 'es' && i.es ? i.es : i.en);
  const draftValid = draft !== null && draft.items.length > 0 && draft.items.every((i) => i.en.trim().length > 0);

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title={t('whatsnew.pageTitle')}
        subtitle={t('whatsnew.pageSubtitle')}
        primaryAction={
          canEdit ? (
            <Button onClick={() => setDraft(draftFrom(null))}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> {t('whatsNewPage.newNote')}
            </Button>
          ) : undefined
        }
    >

      {notes.isError ? (
        <QueryError what={t('whatsNewPage.loadWhat')} query={notes} />
      ) : notes.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (notes.data?.notes ?? []).length === 0 ? (
        <EmptyState icon={Sparkles} title={t('whatsnew.empty')} description="" />
      ) : (
        <div className="space-y-3">
          {(notes.data?.notes ?? []).map((note) => (
            <Card key={note.id}>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium text-white">{fmtDate(parseYmd(note.day))}</h2>
                  {note.publishedAt === null && <Badge variant="pending">{t('whatsnew.draft')}</Badge>}
                  {canEdit && (
                    // Edit and delete behind one "⋯" per note, not two icons on every card (F500 2026-10-26).
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={t('whatsNewPage.moreAria', { day: fmtDate(parseYmd(note.day)) })}>
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDraft(draftFrom(note))}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('whatsNewPage.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          destructive
                          onSelect={async () => {
                            if (!(await confirm({ title: t('whatsNewPage.deleteConfirm'), destructive: true }))) return;
                            remove.mutate(note.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {t('whatsNewPage.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <ul className="space-y-1.5 text-sm text-silver">
                  {note.items.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-gold" aria-hidden="true">
                        ·
                      </span>
                      <span className="min-w-0 break-words">
                        {text(item)}
                        {canEdit && item.audience !== 'ALL' && (
                          <Badge variant="outline" className="ml-2 text-2xs">
                            {t(AUDIENCE_LABEL[item.audience])}
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
          <p className="pt-1 text-sm text-ink-muted">
            {t('whatsNewPage.questions')}{' '}
            <Link to="/support" className="text-accent underline underline-offset-2">
              {t('whatsNewPage.contactSupport')}
            </Link>
          </p>
        </div>
      )}

      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <>
            <DrawerHeader>
              <DrawerTitle>{draft.id ? t('whatsNewPage.editTitle') : t('whatsNewPage.newTitle')}</DrawerTitle>
            </DrawerHeader>
            <DrawerBody className="space-y-4">
              <div>
                <Label htmlFor="rn-day">{t('whatsNewPage.releaseDay')}</Label>
                <Input id="rn-day" type="date" className="mt-1" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
              </div>
              <div className="space-y-3">
                {draft.items.map((item, idx) => (
                  <div key={idx} className="rounded-md border border-navy-secondary p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`rn-aud-${idx}`} className="sr-only">
                        {t('whatsNewPage.audienceLabel')}
                      </Label>
                      <Select
                        id={`rn-aud-${idx}`}
                        size="sm"
                        value={item.audience}
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[idx] = { ...item, audience: e.target.value as ReleaseNoteAudience };
                          setDraft({ ...draft, items });
                        }}
                      >
                        {RELEASE_NOTE_AUDIENCES.map((a) => (
                          <option key={a} value={a}>
                            {t(AUDIENCE_LABEL[a])}
                          </option>
                        ))}
                      </Select>
                      {draft.items.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto text-silver hover:text-alert"
                          aria-label={t('whatsNewPage.removeBulletAria', { n: idx + 1 })}
                          onClick={() => setDraft({ ...draft, items: draft.items.filter((_, i) => i !== idx) })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                    <div>
                      <Label htmlFor={`rn-en-${idx}`}>English</Label>
                      <Textarea
                        id={`rn-en-${idx}`}
                        className="mt-1"
                        rows={2}
                        value={item.en}
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[idx] = { ...item, en: e.target.value };
                          setDraft({ ...draft, items });
                        }}
                      />
                    </div>
                    <div>
                      <Label htmlFor={`rn-es-${idx}`}>{t('whatsNewPage.spanishLabel')}</Label>
                      <Textarea
                        id={`rn-es-${idx}`}
                        className="mt-1"
                        rows={2}
                        value={item.es ?? ''}
                        onChange={(e) => {
                          const items = [...draft.items];
                          items[idx] = { ...item, es: e.target.value };
                          setDraft({ ...draft, items });
                        }}
                      />
                    </div>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setDraft({ ...draft, items: [...draft.items, { ...EMPTY_ITEM }] })}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> {t('whatsNewPage.addBullet')}
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm text-silver">
                <input type="checkbox" className="h-4 w-4 accent-gold" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} />
                {t('whatsNewPage.publishedCheckbox')}
              </label>
            </DrawerBody>
            <DrawerFooter>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!draftValid || save.isPending}>
                {draft.published ? t('whatsNewPage.publish') : t('whatsNewPage.saveDraft')}
              </Button>
            </DrawerFooter>
          </>
        )}
      </Drawer>
    </ListTemplate>
  );
}
