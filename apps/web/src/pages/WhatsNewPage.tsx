import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { RELEASE_NOTE_AUDIENCES, type ReleaseNote, type ReleaseNoteAudience, type ReleaseNoteInput, type ReleaseNoteItem } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, parseYmd } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { createReleaseNote, deleteReleaseNote, listReleaseNotes, updateReleaseNote } from '@/lib/releaseNotesApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Drawer, DrawerBody, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input, Textarea } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Every release note, newest first — the history behind the home-screen
 * card — and, for people who can manage the org, the place a note is
 * written. A note is a day and a list of bullets; each bullet names its
 * audience and carries English plus optional Spanish. Publishing is a
 * checkbox: a draft is visible only here, only to editors.
 */

const AUDIENCE_LABEL: Record<ReleaseNoteAudience, string> = {
  ALL: 'Everyone',
  ADMIN: 'Admins & managers',
  ASSOCIATE: 'Associates',
  SUPERVISOR: 'Shift supervisors',
  DRIVER: 'Drivers',
  CLIENT: 'Store portal',
};

const EMPTY_ITEM: ReleaseNoteItem = { audience: 'ALL', en: '', es: null };

type Draft = { id: string | null; day: string; items: ReleaseNoteItem[]; published: boolean };

function draftFrom(note: ReleaseNote | null): Draft {
  return note
    ? { id: note.id, day: note.day, items: note.items.map((i) => ({ ...i })), published: note.publishedAt !== null }
    : { id: null, day: new Date().toISOString().slice(0, 10), items: [{ ...EMPTY_ITEM }], published: false };
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
      toast.success(d.published ? 'Release note published.' : 'Draft saved.');
      setDraft(null);
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the note.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteReleaseNote(id),
    onSuccess: () => {
      toast.success('Release note deleted.');
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the note.'),
  });

  const canEdit = notes.data?.canEdit ?? false;
  const text = (i: ReleaseNoteItem) => (lang === 'es' && i.es ? i.es : i.en);
  const draftValid = draft !== null && draft.items.length > 0 && draft.items.every((i) => i.en.trim().length > 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('whatsnew.pageTitle')}
        subtitle={t('whatsnew.pageSubtitle')}
        secondaryActions={
          canEdit ? (
            <Button onClick={() => setDraft(draftFrom(null))}>
              <Plus className="mr-2 h-4 w-4" /> New note
            </Button>
          ) : undefined
        }
      />

      {notes.isError ? (
        <QueryError what="release notes" query={notes} />
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
                    <div className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setDraft(draftFrom(note))} aria-label={`Edit note for ${note.day}`}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-silver hover:text-alert"
                        aria-label={`Delete note for ${note.day}`}
                        onClick={async () => {
                          if (!(await confirm({ title: 'Delete this release note?', destructive: true }))) return;
                          remove.mutate(note.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
                            {AUDIENCE_LABEL[item.audience]}
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Drawer open={draft !== null} onOpenChange={(o) => !o && setDraft(null)}>
        {draft && (
          <>
            <DrawerHeader>
              <DrawerTitle>{draft.id ? 'Edit release note' : 'New release note'}</DrawerTitle>
            </DrawerHeader>
            <DrawerBody className="space-y-4">
              <div>
                <Label htmlFor="rn-day">Release day</Label>
                <Input id="rn-day" type="date" className="mt-1" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
              </div>
              <div className="space-y-3">
                {draft.items.map((item, idx) => (
                  <div key={idx} className="rounded-md border border-navy-secondary p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`rn-aud-${idx}`} className="sr-only">
                        Audience
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
                            {AUDIENCE_LABEL[a]}
                          </option>
                        ))}
                      </Select>
                      {draft.items.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto text-silver hover:text-alert"
                          aria-label={`Remove bullet ${idx + 1}`}
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
                      <Label htmlFor={`rn-es-${idx}`}>Español (optional — English shows when empty)</Label>
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
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add a bullet
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm text-silver">
                <input type="checkbox" className="h-4 w-4 accent-gold" checked={draft.published} onChange={(e) => setDraft({ ...draft, published: e.target.checked })} />
                Published — on every home screen at the next open
              </label>
            </DrawerBody>
            <DrawerFooter>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!draftValid || save.isPending}>
                {draft.published ? 'Publish' : 'Save draft'}
              </Button>
            </DrawerFooter>
          </>
        )}
      </Drawer>
    </div>
  );
}
