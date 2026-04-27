import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { nudgeApplicant } from '@/lib/onboardingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';

const TEXTAREA_CX =
  'mt-1 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm ' +
  'focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  applicationId: string | null;
  /** Shown in the dialog header — read-only, just for context. */
  associateName: string;
  /** Default subject line based on what's missing. Optional. */
  suggestedSubject?: string;
}

const DEFAULT_SUBJECT = 'Quick check-in on your onboarding';
const DEFAULT_BODY = [
  'Hi,',
  '',
  "Just checking in — we noticed you have a few onboarding tasks still pending. Could you take a few minutes to wrap them up so we can get you scheduled?",
  '',
  "If you ran into any issues with the link or the forms, just reply to this email and we'll help.",
  '',
  'Thanks!',
].join('\n');

/**
 * HR-composed free-form email to an associate stuck mid-onboarding.
 * Different from a resend: doesn't rotate tokens, doesn't wipe state.
 * Just an email + an audit log + a Notification row tagged
 * `onboarding.nudge`.
 */
export function NudgeDialog({
  open,
  onOpenChange,
  applicationId,
  associateName,
  suggestedSubject,
}: Props) {
  const [subject, setSubject] = useState(suggestedSubject ?? DEFAULT_SUBJECT);
  const [body, setBody] = useState(DEFAULT_BODY);
  const [submitting, setSubmitting] = useState(false);

  // Reset to defaults whenever the dialog opens for a new applicant.
  useEffect(() => {
    if (open) {
      setSubject(suggestedSubject ?? DEFAULT_SUBJECT);
      setBody(DEFAULT_BODY);
    }
  }, [open, suggestedSubject]);

  const submit = async () => {
    if (!applicationId) return;
    if (!subject.trim()) {
      toast.error('Subject required');
      return;
    }
    if (!body.trim()) {
      toast.error('Body required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await nudgeApplicant(applicationId, {
        subject: subject.trim(),
        body: body.trim(),
      });
      if (res.emailSent) {
        toast.success(`Nudge sent to ${res.recipientEmail}`);
      } else {
        toast.message('Nudge logged — email delivery failed', {
          description: 'The Notification row was created. Check email config.',
        });
      }
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not send nudge';
      toast.error('Could not send', { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nudge {associateName || 'applicant'}</DialogTitle>
          <DialogDescription>
            Sends a one-off email. Doesn't rotate the invite token — use
            "Resend invite" for that.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="nd-subject" required>
              Subject
            </Label>
            <Input
              id="nd-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="nd-body" required>
              Body
            </Label>
            <textarea
              id="nd-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={9}
              maxLength={4000}
              className={TEXTAREA_CX}
            />
            <FormHint>
              Plain text. Logged to the application audit and the associate's
              notification inbox.
            </FormHint>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={submitting}>
            <Send className="h-4 w-4" />
            Send nudge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
