import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink, ImagePlus, Plus, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getEmployerBrand, removeBrandPhoto, saveEmployerBrand, uploadBrandPhoto, type EmployerBrand } from '@/lib/marketingApi';
import { useConfirm } from '@/lib/confirm';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The employer brand page: what the public careers site says about working
 * here — a headline, an introduction, the values, the perks, and photos.
 * Marketing edits it; the careers site renders it above the open jobs.
 */

type Draft = { headline: string; intro: string; values: Array<{ title: string; body: string }>; perks: string[]; ctaText: string };

const toDraft = (b: EmployerBrand): Draft => ({
  headline: b.headline ?? '',
  intro: b.intro ?? '',
  values: b.values.length ? b.values : [],
  perks: b.perks,
  ctaText: b.ctaText ?? '',
});

export function EmployerBrandEditor({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['marketing', 'brand'], queryFn: getEmployerBrand });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [newPerk, setNewPerk] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  useEffect(() => {
    if (q.data && draft === null) setDraft(toDraft(q.data));
  }, [q.data, draft]);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveEmployerBrand({
        headline: d.headline.trim() || null,
        intro: d.intro.trim() || null,
        values: d.values.filter((v) => v.title.trim()).map((v) => ({ title: v.title.trim(), body: v.body.trim() })),
        perks: d.perks.map((p) => p.trim()).filter(Boolean),
        ctaText: d.ctaText.trim() || null,
      }),
    onSuccess: (b) => {
      queryClient.setQueryData(['marketing', 'brand'], b);
      setDraft(toDraft(b));
      toast.success('Careers page updated.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the page.'),
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadBrandPhoto(file, file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') || 'Working here'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['marketing', 'brand'] });
      toast.success('Photo added.');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not upload the photo.'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeBrandPhoto(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['marketing', 'brand'] }),
    onError: () => toast.error('Could not remove the photo.'),
  });

  if (q.isError) return <QueryError what="the careers page" query={q} />;
  if (!draft || !q.data) return <Skeleton className="h-96" />;
  const brand = q.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(brand));
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardContent className="space-y-4">
            <SectionTitle
              title="Words"
              description="The headline and introduction above the open jobs."
              as="h3"
              trailing={
                <Link to="/careers" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  See the careers page
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </Link>
              }
            />
            <Field label="Headline" hint="Eight words or fewer reads best.">
              {(p) => <Input {...p} value={draft.headline} maxLength={160} disabled={!canEdit} onChange={(e) => set({ headline: e.target.value })} placeholder="Work with us" />}
            </Field>
            <Field label="Introduction" hint="Two or three sentences about who you are and what a week looks like.">
              {(p) => <Textarea {...p} rows={4} value={draft.intro} maxLength={2000} disabled={!canEdit} onChange={(e) => set({ intro: e.target.value })} />}
            </Field>
            <Field label="Button text" hint="On every job's application form.">
              {(p) => <Input {...p} value={draft.ctaText} maxLength={80} disabled={!canEdit} onChange={(e) => set({ ctaText: e.target.value })} placeholder="Send application" />}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <SectionTitle
              title="Values"
              description="Up to eight, each with a line underneath."
              as="h3"
              trailing={
                canEdit && draft.values.length < 8 ? (
                  <Button size="xs" variant="outline" onClick={() => set({ values: [...draft.values, { title: '', body: '' }] })}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add a value
                  </Button>
                ) : undefined
              }
            />
            {draft.values.length === 0 ? (
              <p className="text-sm text-ink-muted">Add the two or three things that are true about working here.</p>
            ) : (
              <ul className="space-y-3">
                {draft.values.map((v, i) => (
                  <li key={i} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[1fr_2fr_auto]">
                    <Input aria-label={`Value ${i + 1} title`} value={v.title} maxLength={80} disabled={!canEdit} placeholder="Reliable" onChange={(e) => set({ values: draft.values.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                    <Input aria-label={`Value ${i + 1} line`} value={v.body} maxLength={400} disabled={!canEdit} placeholder="We show up, on time, every shift." onChange={(e) => set({ values: draft.values.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} />
                    {canEdit && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove value ${i + 1}`} onClick={() => set({ values: draft.values.filter((_, j) => j !== i) })}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3">
            <SectionTitle title="Perks" description="Short, concrete: weekly pay, rides to work, a uniform on day one." as="h3" />
            <div className="flex flex-wrap gap-2">
              {draft.perks.map((p, i) => (
                <span key={`${p}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs">
                  {p}
                  {canEdit && (
                    <button type="button" aria-label={`Remove ${p}`} className="text-ink-muted hover:text-alert" onClick={() => set({ perks: draft.perks.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEdit && draft.perks.length < 12 && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = newPerk.trim();
                  if (!v) return;
                  set({ perks: [...draft.perks, v] });
                  setNewPerk('');
                }}
              >
                <Input aria-label="New perk" value={newPerk} maxLength={80} placeholder="Weekly pay" onChange={(e) => setNewPerk(e.target.value)} />
                <Button type="submit" variant="outline" disabled={!newPerk.trim()}>
                  Add
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {canEdit && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(toDraft(brand))}>
              Discard
            </Button>
            <Button loading={save.isPending} disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
              Publish to the careers page
            </Button>
          </div>
        )}
      </div>

      <Card className="h-fit">
        <CardContent className="space-y-3">
          <SectionTitle
            title="Photos"
            description="Up to eight, shown above the jobs. Real people on real shifts beat stock."
            as="h3"
            trailing={
              canEdit && brand.photos.length < 8 ? (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    aria-label="Add a photo"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) upload.mutate(f);
                      e.target.value = '';
                    }}
                  />
                  <Button size="xs" variant="outline" loading={upload.isPending} onClick={() => fileInput.current?.click()}>
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add
                  </Button>
                </>
              ) : undefined
            }
          />
          {brand.photos.length === 0 ? (
            <p className="text-sm text-ink-muted">A couple of photos of the floor make the page feel like a place.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-2">
              {brand.photos.map((p) => (
                <li key={p.id} className="group relative overflow-hidden rounded-md border border-line">
                  <img src={p.url} alt={p.alt} className="aspect-[4/3] w-full object-cover" />
                  {canEdit && (
                    <Button
                      size="icon-sm"
                      variant="secondary"
                      className="absolute right-1 top-1"
                      aria-label={`Remove photo: ${p.alt}`}
                      loading={remove.isPending && remove.variables === p.id}
                      onClick={async () => {
                        if (await confirm({ title: 'Remove this photo from the careers page?', confirmLabel: 'Remove', destructive: true })) remove.mutate(p.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
