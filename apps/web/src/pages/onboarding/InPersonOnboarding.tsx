import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  Camera,
  Check,
  ChevronLeft,
  FileText,
  Upload,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ApplicationDetail as ApplicationDetailType,
  DocumentKind,
  DocumentRecord,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  approveApplication,
  finishDocumentUpload,
  getApplication,
  resendInvite,
} from '@/lib/onboardingApi';
import {
  listAdminDocuments,
  uploadAdminDocument,
} from '@/lib/documentsApi';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { DocumentCapture } from '@/components/DocumentCapture';
import { cn } from '@/lib/cn';

/**
 * Phase 145 — In-person onboarding workspace.
 *
 * Used when the associate is physically at the office and HR is sitting
 * with them to get things moving. Concentrates the parts of onboarding
 * an admin can legitimately do on the associate's behalf:
 *   1. Scan / photograph identity documents and upload them as
 *      VERIFIED (the admin is physically holding the ID, the in-person
 *      scan IS the verification).
 *   2. Mark policies as reviewed in person.
 *   3. Approve the application once the checklist hits 100%.
 *
 * What the admin CANNOT do on their behalf (legally — these are the
 * associate's own attestations): I-9 Section 1 signature, W-4, e-sign
 * agreements, background-check authorization. For those the wizard
 * surfaces a hand-off card with the associate's invite link so they
 * can complete them on the device.
 */

const ID_KINDS: Array<{ value: DocumentKind; label: string }> = [
  { value: 'ID', label: 'Government photo ID (driver license / passport)' },
  { value: 'SSN_CARD', label: 'Social Security card' },
  { value: 'I9_SUPPORTING', label: 'Other I-9 supporting document' },
];

const TASK_LABEL: Record<string, string> = {
  PROFILE_INFO: 'Profile info',
  DOCUMENT_UPLOAD: 'ID documents',
  W4: 'W-4 tax form',
  DIRECT_DEPOSIT: 'Direct deposit',
  POLICY_ACK: 'Policy acknowledgement',
  I9_VERIFICATION: 'I-9 verification',
  E_SIGN: 'E-sign agreements',
  BACKGROUND_CHECK: 'Background check',
  J1_DOCS: 'J-1 documents',
};

// Tasks the admin cannot legitimately complete on the associate's behalf.
// Surfaced in the hand-off card so the admin knows what's left for the
// associate to do themselves on this device.
const SELF_ATTESTATION_KINDS = new Set([
  'I9_VERIFICATION',
  'E_SIGN',
  'BACKGROUND_CHECK',
  'W4',
  'DIRECT_DEPOSIT',
]);

export function InPersonOnboarding() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ApplicationDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState(false);
  const [docKind, setDocKind] = useState<DocumentKind>('ID');
  const [showCamera, setShowCamera] = useState(false);
  const [finishingDocs, setFinishingDocs] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!applicationId) return;
    try {
      const d = await getApplication(applicationId);
      setDetail(d);
      const r = await listAdminDocuments({ associateId: d.associateId });
      setDocs(r.documents);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [applicationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleUploadFile = async (file: File, kind: DocumentKind) => {
    if (!detail) return;
    setUploading(true);
    try {
      await uploadAdminDocument(file, kind, detail.associateId);
      toast.success(`${file.name} uploaded`);
      await refresh();
    } catch (err) {
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUploading(false);
    }
  };

  const onCameraCapture = async (file: File) => {
    setShowCamera(false);
    await handleUploadFile(file, docKind);
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow same-file re-selection
    if (!file) return;
    void handleUploadFile(file, docKind);
  };

  const handleResendInvite = async () => {
    if (!detail) return;
    try {
      const res = await resendInvite(detail.id);
      if (res.inviteUrl) {
        await navigator.clipboard.writeText(res.inviteUrl).catch(() => {});
        toast.success('Invite link copied to clipboard');
      } else {
        toast.success('Fresh invite sent to associate');
      }
    } catch {
      toast.error('Could not resend invite');
    }
  };

  const markDocumentsComplete = async () => {
    if (!applicationId) return;
    setFinishingDocs(true);
    try {
      await finishDocumentUpload(applicationId);
      toast.success('Documents marked submitted');
      await refresh();
    } catch (err) {
      toast.error('Could not mark complete', {
        description: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setFinishingDocs(false);
    }
  };

  if (error) {
    return (
      <div className="max-w-3xl mx-auto">
        <PageHeader
          title="In-person onboarding"
          breadcrumbs={[
            { label: 'Onboarding', to: '/onboarding' },
            { label: 'In-person session' },
          ]}
        />
        <ErrorBanner>{error}</ErrorBanner>
      </div>
    );
  }

  if (!detail || !applicationId) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  const idDocs = docs.filter((d) =>
    d.kind === 'ID' || d.kind === 'SSN_CARD' || d.kind === 'I9_SUPPORTING',
  );
  const docTask = detail.tasks.find((t) => t.kind === 'DOCUMENT_UPLOAD');
  const docTaskDone = docTask?.status === 'DONE' || docTask?.status === 'SKIPPED';

  const outstandingForAssociate = detail.tasks.filter(
    (t) =>
      t.status !== 'DONE' &&
      t.status !== 'SKIPPED' &&
      SELF_ATTESTATION_KINDS.has(t.kind),
  );

  const checklistComplete = detail.percentComplete === 100;
  const decided = detail.status === 'APPROVED' || detail.status === 'REJECTED';

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="In-person onboarding"
        subtitle={
          <>
            With{' '}
            <span className="text-white">
              {detail.associateName}
            </span>{' '}
            for {detail.clientName}
            {detail.position && ` · ${detail.position}`}
          </>
        }
        breadcrumbs={[
          { label: 'Onboarding', to: '/onboarding' },
          { label: 'In-person session' },
        ]}
        primaryAction={
          <Button asChild variant="ghost">
            <Link to={`/onboarding/applications/${detail.id}`}>
              <ChevronLeft className="h-4 w-4" />
              Back to detail
            </Link>
          </Button>
        }
      />

      <div className="space-y-5">
        {/* Status + progress strip */}
        <Card>
          <CardContent className="pt-5 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-silver/80">
                Application status
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={statusVariant(detail.status)}>
                  {detail.status}
                </Badge>
                <span className="text-sm text-silver tabular-nums">
                  Checklist {detail.percentComplete}%
                </span>
              </div>
            </div>
            {!decided && checklistComplete && (
              <Button onClick={() => setApproveOpen(true)}>
                <UserCheck className="h-4 w-4" />
                Approve hire
              </Button>
            )}
          </CardContent>
        </Card>

        {/* 1. Scan documents */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="h-4 w-4 text-silver/80" />
              1. Scan identity documents
              {docTaskDone && (
                <Badge variant="success" className="ml-1">
                  Submitted
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-silver">
              Use the laptop / tablet camera, or pick a file. Each scan is
              uploaded directly to the associate's profile as a verified
              document — you're physically holding the ID, so the in-person
              capture <em>is</em> the verification.
            </p>

            <Field label="Document type">
              {(p) => (
                <Select
                  value={docKind}
                  onChange={(e) => setDocKind(e.target.value as DocumentKind)}
                  disabled={uploading}
                  {...p}
                >
                  {ID_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setShowCamera(true)}
                disabled={uploading}
                variant="secondary"
              >
                <Camera className="h-4 w-4" />
                Scan with camera
              </Button>
              <label
                className={cn(
                  'inline-flex items-center gap-2 h-10 px-4 rounded-md border border-navy-secondary bg-navy-secondary/40 text-white text-sm hover:border-silver/40 hover:bg-navy-secondary hover:elev-1 hover:-translate-y-0.5 transition cursor-pointer',
                  uploading && 'opacity-50 cursor-wait',
                )}
              >
                <Upload className="h-4 w-4" />
                {uploading ? 'Uploading…' : 'Pick a file'}
                <input
                  type="file"
                  className="hidden"
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  onChange={onPickFile}
                  disabled={uploading}
                />
              </label>
            </div>

            {/* Uploaded list */}
            {idDocs.length > 0 ? (
              <div>
                <div className="text-xs uppercase tracking-widest text-silver/80 mb-2">
                  Captured so far ({idDocs.length})
                </div>
                <ul className="space-y-1.5">
                  {idDocs.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center gap-2 p-2 rounded border border-navy-secondary bg-navy-secondary/30"
                    >
                      <Check className="h-3.5 w-3.5 text-success shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">
                          {d.filename}
                        </div>
                        <div className="text-xs text-silver/80">
                          {d.kind.replace(/_/g, ' ')}
                        </div>
                      </div>
                      <Badge variant="success" className="shrink-0">
                        Verified
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-xs text-silver">
                No documents scanned yet. Start with the photo ID.
              </div>
            )}

            {!docTaskDone && idDocs.length > 0 && (
              <Button
                onClick={markDocumentsComplete}
                loading={finishingDocs}
                variant="secondary"
              >
                Mark documents complete
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </CardContent>
        </Card>

        {/* 2. Hand off for self-attestation */}
        {outstandingForAssociate.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCheck className="h-4 w-4 text-silver/80" />
                2. Hand the device to{' '}
                {detail.associateName.split(' ')[0] ?? 'the associate'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-silver">
                The steps below need the associate's own signature — they
                attest to their identity, tax withholding, and agreement to
                policies. Resend their invite link and let them log in on
                this device to complete each one.
              </p>
              <ul className="space-y-1.5">
                {outstandingForAssociate.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-2 text-sm text-white"
                  >
                    <AlertCircle className="h-3.5 w-3.5 text-warning shrink-0" />
                    {TASK_LABEL[t.kind] ?? t.kind}
                  </li>
                ))}
              </ul>
              <Button variant="secondary" onClick={handleResendInvite}>
                Copy fresh invite link
              </Button>
            </CardContent>
          </Card>
        )}

        {outstandingForAssociate.length === 0 && !decided && checklistComplete && (
          <Card className="border-success/30 bg-success/5">
            <CardContent className="py-5 flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-success/15 grid place-items-center text-success shrink-0">
                <Check className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div className="text-white font-medium">
                  Everything's done.
                </div>
                <div className="text-sm text-silver">
                  Checklist is at 100% and the associate has signed every
                  attestation. Click Approve hire above to finalize.
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {decided && (
          <EmptyState
            icon={Check}
            title={
              detail.status === 'APPROVED'
                ? 'Already approved'
                : 'Already rejected'
            }
            description="This application is closed. Open it from the onboarding list if you need to review the timeline."
            action={
              <Button asChild variant="ghost">
                <Link to="/onboarding">Back to onboarding</Link>
              </Button>
            }
          />
        )}
      </div>

      <Dialog open={showCamera} onOpenChange={setShowCamera}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Scan {ID_KIND_LABEL[docKind]}</DialogTitle>
            <DialogDescription>
              Hold the document flat in front of the camera. Tap Capture
              when the whole document is in frame and legible.
            </DialogDescription>
          </DialogHeader>
          <DocumentCapture
            filenameBase={docKind.toLowerCase()}
            facingMode="environment"
            onCapture={onCameraCapture}
            onCancel={() => setShowCamera(false)}
          />
        </DialogContent>
      </Dialog>

      <ApproveDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        defaultDate={detail.startDate ? detail.startDate.slice(0, 10) : null}
        onConfirm={async (hireDate) => {
          try {
            await approveApplication(detail.id, { hireDate });
            toast.success('Approved.');
            setApproveOpen(false);
            navigate(`/onboarding/applications/${detail.id}`, { replace: true });
          } catch (err) {
            toast.error('Approval failed', {
              description: err instanceof ApiError ? err.message : undefined,
            });
          }
        }}
      />
    </div>
  );
}

function statusVariant(
  s: string,
): 'success' | 'pending' | 'destructive' | 'default' {
  if (s === 'APPROVED') return 'success';
  if (s === 'REJECTED') return 'destructive';
  if (s === 'SUBMITTED' || s === 'IN_REVIEW') return 'pending';
  return 'default';
}

const ID_KIND_LABEL: Record<DocumentKind, string> = {
  ID: 'photo ID',
  SSN_CARD: 'Social Security card',
  I9_SUPPORTING: 'I-9 supporting document',
  W4_PDF: 'W-4',
  OFFER_LETTER: 'offer letter',
  POLICY: 'policy',
  HOUSING_AGREEMENT: 'housing agreement',
  TRANSPORT_AGREEMENT: 'transport agreement',
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
  SIGNED_AGREEMENT: 'signed agreement',
  BACKGROUND_CHECK_RESULT: 'background-check result',
  DRUG_TEST_RESULT: 'drug-test result',
  I9_VERIFICATION_RESULT: 'I-9 verification result',
  OTHER: 'document',
};

function ApproveDialog({
  open,
  onOpenChange,
  defaultDate,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDate: string | null;
  onConfirm: (hireDate: string) => Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [hireDate, setHireDate] = useState(defaultDate ?? today);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHireDate(defaultDate ?? today);
    setBusy(false);
  }, [open, defaultDate, today]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve hire</DialogTitle>
          <DialogDescription>
            Pick the hire date — this becomes the associate's start date
            and stamps the Associate record.
          </DialogDescription>
        </DialogHeader>
        <Field label="Hire date" required>
          {(p) => (
            <Input
              type="date"
              value={hireDate}
              onChange={(e) => setHireDate(e.target.value)}
              {...p}
            />
          )}
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setBusy(true);
              await onConfirm(hireDate);
              setBusy(false);
            }}
            loading={busy}
            disabled={!hireDate}
          >
            <UserCheck className="h-4 w-4" />
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
