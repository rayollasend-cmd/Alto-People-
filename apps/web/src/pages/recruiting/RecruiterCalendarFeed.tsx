import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Copy, RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useConfirm } from '@/lib/confirm';
import { getRecruiterCalendarUrl, rotateRecruiterCalendarUrl } from '@/lib/candidatePortalApi';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * The recruiter's interviews in their own calendar: a feed URL any
 * calendar app subscribes to, kept current — beside the invite each
 * interview already emails. The URL is the key; a leaked one is retired
 * with one click, which mints a new one.
 */
export function RecruiterCalendarFeed() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['recruiting', 'calendar-url'], queryFn: getRecruiterCalendarUrl, enabled: open });
  const rotate = useMutation({
    mutationFn: rotateRecruiterCalendarUrl,
    onSuccess: (r) => {
      queryClient.setQueryData(['recruiting', 'calendar-url'], r);
      toast.success('New feed link — the old one no longer works.');
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not rotate the link.'),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy — select the link and copy it yourself.');
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <CalendarPlus className="h-4 w-4" aria-hidden="true" />
        Add to my calendar
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Interviews in your calendar</DialogTitle>
            <DialogDescription>
              Subscribe once and every interview stays current in Google Calendar, Outlook or Apple Calendar — the same event the invite emails, so nothing doubles up.
            </DialogDescription>
          </DialogHeader>
          {q.isError ? (
            <p className="text-sm text-alert">{q.error instanceof ApiError ? q.error.message : 'Could not load the link.'}</p>
          ) : !q.data ? (
            <Skeleton className="h-20" />
          ) : (
            <div className="space-y-3">
              <label className="block text-xs text-ink-muted">
                Subscription link
                <div className="mt-1 flex gap-2">
                  <Input readOnly value={q.data.url} aria-label="Calendar subscription link" onFocus={(e) => e.currentTarget.select()} />
                  <Button variant="outline" size="icon" aria-label="Copy the link" onClick={() => void copy(q.data.url)}>
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </label>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="secondary">
                  <a href={q.data.webcalUrl}>Open in Apple Calendar or Outlook</a>
                </Button>
                <Button asChild size="sm" variant="secondary">
                  <a href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(q.data.webcalUrl)}`} target="_blank" rel="noopener noreferrer">
                    Add to Google Calendar
                  </a>
                </Button>
              </div>
              <p className="text-2xs text-ink-muted">Anyone with this link can read your interviews. If it leaks, make a new one — the old one stops working.</p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              loading={rotate.isPending}
              onClick={async () => {
                if (await confirm({ title: 'Make a new link?', description: 'Every calendar subscribed to the old link goes dark until you add the new one.', confirmLabel: 'Make a new link' })) rotate.mutate();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              New link
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
