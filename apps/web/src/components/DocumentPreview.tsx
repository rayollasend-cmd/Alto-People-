import { Download, ExternalLink, FileText, FileWarning } from 'lucide-react';
import type { DocumentRecord } from '@alto-people/shared';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Badge } from '@/components/ui/Badge';
import {
  downloadDocumentUrl,
  isPreviewable,
  previewDocumentUrl,
} from '@/lib/documentsApi';
import { cn } from '@/lib/cn';
import { fmtSize } from '@/lib/format';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';

const STATUS_VARIANT: Record<
  DocumentRecord['status'],
  'success' | 'pending' | 'destructive' | 'default'
> = {
  UPLOADED: 'pending',
  VERIFIED: 'success',
  REJECTED: 'destructive',
  EXPIRED: 'destructive',
};


interface DocumentPreviewProps {
  doc: DocumentRecord | null;
  onOpenChange: (open: boolean) => void;
  /** Optional inline action area (verify / reject) shown in the header. */
  actions?: React.ReactNode;
}

/**
 * In-platform viewer for uploaded documents. Renders PDFs in a sandboxed
 * iframe and images in an <img>; everything else falls back to a download
 * prompt. The Dialog is sized large so the file actually fits, with the
 * filename + status header pinned at top and a download / open-in-tab footer
 * pinned at bottom.
 */
export function DocumentPreview({ doc, onOpenChange, actions }: DocumentPreviewProps) {
  const { t } = useI18n();
  const open = doc !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'max-w-5xl w-[95vw] h-[90vh]',
          'p-0 gap-0 grid-rows-[auto,1fr,auto]',
          'overflow-hidden',
        )}
      >
        {doc && (
          <>
            <header className="px-5 py-3 pr-14 border-b border-navy-secondary flex items-start gap-3">
              <FileText className="h-5 w-5 text-gold mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-base font-medium text-white truncate">
                  {doc.filename}
                </DialogTitle>
                <DialogDescription className="text-xs text-silver mt-0.5 flex items-center gap-2 flex-wrap">
                  {/* The translated kind label, not the raw enum code. */}
                  <span>{t(('docs.kind.' + doc.kind) as MessageKey)}</span>
                  <span className="text-silver/70">·</span>
                  <span>{fmtSize(doc.size)}</span>
                  <span className="text-silver/70">·</span>
                  <span>{doc.mimeType}</span>
                  {doc.associateName && (
                    <>
                      <span className="text-silver/70">·</span>
                      <span>{doc.associateName}</span>
                    </>
                  )}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={STATUS_VARIANT[doc.status]}>
                  {t(('docs.status.' + doc.status) as MessageKey)}
                </Badge>
                {actions}
              </div>
            </header>

            <div className="bg-midnight overflow-hidden flex items-center justify-center">
              <PreviewBody doc={doc} t={t} />
            </div>

            <footer className="px-5 py-3 border-t border-navy-secondary flex items-center justify-between gap-3">
              <div className="text-xs text-silver">
                {!doc.fileAvailable ? (
                  <span className="text-alert">{t('docs.fileGoneFooter')}</span>
                ) : doc.rejectionReason ? (
                  <span className="text-alert">
                    {t('docs.rejectedReasonLine', { reason: doc.rejectionReason })}
                  </span>
                ) : doc.verifiedAt ? (
                  doc.verifierEmail ? (
                    t('docs.verifiedBy', { who: doc.verifierEmail })
                  ) : (
                    t('docs.verifiedPlain')
                  )
                ) : (
                  t('docs.awaitingReview')
                )}
              </div>
              <div className="flex items-center gap-2">
                {doc.fileAvailable ? (
                  <>
                    <a
                      href={previewDocumentUrl(doc.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-white px-2 py-1 rounded border border-navy-secondary hover:border-silver/50 transition"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t('docs.openTab')}
                    </a>
                    <a
                      href={downloadDocumentUrl(doc.id)}
                      className="btn-gold inline-flex items-center gap-1.5 text-xs text-navy px-2.5 py-1 rounded font-medium"
                    >
                      <Download className="h-3.5 w-3.5" />
                      {t('docs.download')}
                    </a>
                  </>
                ) : (
                  <span className="text-xs text-silver/70">
                    {t('docs.fileGoneActions')}
                  </span>
                )}
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ doc, t }: { doc: DocumentRecord; t: Translate }) {
  const url = previewDocumentUrl(doc.id);
  if (!doc.fileAvailable) {
    return (
      <div className="text-center px-8 max-w-md">
        <FileWarning className="h-10 w-10 text-alert mx-auto mb-3" />
        <p className="text-white font-medium">{t('docs.fileGoneTitle')}</p>
        {/* Audience-neutral wording — associates see this dialog too, so
            "ask the associate to re-upload" read like leaked admin notes. */}
        <p className="text-sm text-silver mt-1">{t('docs.fileGoneBody')}</p>
      </div>
    );
  }
  if (doc.mimeType === 'application/pdf') {
    return (
      <iframe
        src={url}
        title={doc.filename}
        className="w-full h-full bg-white"
        // sandbox lets the PDF viewer run but blocks navigation / popups.
        // No allow-popups: a malicious PDF should not be able to open new
        // tabs (phishing surface).
        sandbox="allow-same-origin allow-scripts"
      />
    );
  }
  if (doc.mimeType.startsWith('image/')) {
    return (
      <img
        src={url}
        alt={doc.filename}
        className="max-w-full max-h-full object-contain"
      />
    );
  }
  return (
    <div className="text-center px-8 max-w-md">
      <FileWarning className="h-10 w-10 text-silver/70 mx-auto mb-3" />
      <p className="text-white font-medium">{t('docs.noPreviewTitle')}</p>
      <p className="text-sm text-silver mt-1">
        {t('docs.noPreviewBody', { mime: doc.mimeType })}
      </p>
      <p className="sr-only">{isPreviewable(doc.mimeType) ? '' : 'fallback'}</p>
    </div>
  );
}
