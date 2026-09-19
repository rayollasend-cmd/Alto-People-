import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileText, FolderOpen, Search, Trash2, Upload } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { DeskChipW } from './RelayRequests';
import { WORK_DESKS, WORK_DESK_LABELS, fileSize, uploadWorkFile, workApi, type WorkDesk } from './workTypes';

/**
 * WORK DOCUMENTS — the shelf beside the desk.
 *
 * The forms, spreadsheets, photos and PDFs the work actually runs on:
 * upload one, tag it, leave it on your own shelf or put it on a desk's,
 * and send it to another desk from here. A file can name the person it's
 * about, so it's one click from their record.
 *
 * Not the associate's document vault — that stays on their record, with
 * its own retention. This is the working shelf.
 */

export function UploadDialog({
  open,
  onClose,
  onUploaded,
  myDesk,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
  myDesk: WorkDesk | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [desk, setDesk] = useState<WorkDesk | ''>(myDesk ?? '');
  const [tags, setTags] = useState('');
  const [about, setAbout] = useState<PickedAssociate | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      await uploadWorkFile(file, {
        desk: desk || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        aboutAssociateId: about?.id,
      });
      toast.success(`${file.name} is on the shelf.`);
      setFile(null);
      setTags('');
      setAbout(null);
      onUploaded();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a work document</DialogTitle>
          <DialogDescription>Keep it on your own shelf, or put it on a desk’s where everyone there can find it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <input
            ref={input}
            type="file"
            className="hidden"
            aria-label="Choose a file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex w-full items-center gap-2.5 rounded-lg border border-dashed border-navy-secondary px-3 py-4 text-left text-sm hover:border-gold/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            <Upload className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
            {file ? (
              <span className="min-w-0">
                <span className="block truncate text-white">{file.name}</span>
                <span className="text-xs text-silver/70">{fileSize(file.size)} · choose another</span>
              </span>
            ) : (
              <span className="text-silver">Choose a file — PDF, image, spreadsheet, document</span>
            )}
          </button>
          <label className="block text-sm">
            <span className="mb-1 block text-silver">Whose shelf</span>
            <Select value={desk} onChange={(e) => setDesk(e.target.value as WorkDesk | '')}>
              <option value="">Mine — visible to anyone who looks for it</option>
              {WORK_DESKS.map((d) => (
                <option key={d} value={d}>
                  {WORK_DESK_LABELS[d]}’s shelf
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-silver">Tags (optional)</span>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="onboarding, walmart, W-4" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-silver">About someone (optional)</span>
            <AssociatePicker value={about} onChange={setAbout} placeholder="Search a person…" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!file || busy}>
            <Upload className="h-4 w-4" />
            Put it on the shelf
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RelayFiles({ myDesk }: { myDesk: WorkDesk | null }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<'mine' | 'desk' | 'all'>('all');
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [uploading, setUploading] = useState(false);
  const q = useQuery({ queryKey: ['relay', 'files', scope, search, tag], queryFn: () => workApi.files({ scope, q: search || undefined, tag: tag || undefined }) });
  const remove = useMutation({
    mutationFn: (id: string) => workApi.remove(id),
    onSuccess: () => {
      toast.success('Taken off the shelf.');
      void queryClient.invalidateQueries({ queryKey: ['relay', 'files'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove it.'),
  });
  const files = q.data?.files ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<'mine' | 'desk' | 'all'>
          ariaLabel="Which shelf"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'mine', label: 'Mine' },
            { value: 'desk', label: myDesk ? `${WORK_DESK_LABELS[myDesk]}’s` : 'My desk’s' },
          ]}
        />
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/60" aria-hidden="true" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents…" aria-label="Search work documents" className="h-9 pl-8" />
        </div>
        <Button size="sm" onClick={() => setUploading(true)}>
          <Upload className="h-3.5 w-3.5" />
          Add a document
        </Button>
      </div>

      {(q.data?.tags.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
          {q.data!.tags.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? '' : t)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-2xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                tag === t ? 'border-gold/60 text-gold' : 'border-navy-secondary text-silver hover:text-white',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <Card className="overflow-hidden p-0">
        {q.isLoading ? (
          <Skeleton className="m-3 h-24" />
        ) : files.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="Nothing on this shelf yet"
            description="Put the forms, spreadsheets and photos the work runs on here — then send one to another desk without leaving the relay."
          />
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {files.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-gold" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <a href={f.url} target="_blank" rel="noreferrer noopener" className="block truncate text-sm text-white hover:text-gold-bright hover:underline">
                    {f.name}
                  </a>
                  <span className="flex flex-wrap items-center gap-x-2 text-2xs text-silver/60">
                    <span className="tabular-nums">{fileSize(f.size)}</span>
                    <span>{fmtDate(f.createdAt)}</span>
                    {f.uploadedBy && (
                      <span className="inline-flex items-center gap-1">
                        <Avatar src={f.uploadedBy.photoUrl} name={f.uploadedBy.name} size="xs" />
                        {f.uploadedBy.name}
                      </span>
                    )}
                    {f.about && (
                      <Link to={`/people?associateId=${f.about.associateId}&return=${encodeURIComponent('/relay?tab=files')}`} className="text-gold/80 hover:underline">
                        about {f.about.name}
                      </Link>
                    )}
                    {f.tags.map((t) => (
                      <span key={t} className="rounded-full bg-navy-secondary px-1.5 py-0.5 text-silver">
                        {t}
                      </span>
                    ))}
                  </span>
                </span>
                {f.desk && <DeskChipW desk={f.desk} />}
                <a href={f.url} download aria-label={`Download ${f.name}`} className="rounded p-1 text-silver/60 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
                  <Download className="h-4 w-4" />
                </a>
                {f.uploadedBy?.userId === user?.id && (
                  <button
                    type="button"
                    onClick={() => remove.mutate(f.id)}
                    aria-label={`Take ${f.name} off the shelf`}
                    className="rounded p-1 text-silver/50 hover:text-alert focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <UploadDialog open={uploading} onClose={() => setUploading(false)} myDesk={myDesk} onUploaded={() => void queryClient.invalidateQueries({ queryKey: ['relay', 'files'] })} />
    </div>
  );
}
