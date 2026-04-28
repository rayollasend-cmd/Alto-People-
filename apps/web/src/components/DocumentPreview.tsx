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

const STATUS_VARIANT: Record<
  DocumentRecord['status'],
  'success' | 'pending' | 'destructive' | 'default'
> = {
  UPLOADED: 'pending',
  VERIFIED: 'success',
  REJECTED: 'destructive',
  EXPIRED: 'destructive',
};

const fmtSize = (b: number): string => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
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
                  <span className="uppercase tracking-wider">
                    {doc.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="text-silver/40">·</span>
                  <span>{fmtSize(doc.size)}</span>
                  <span className="text-silver/40">·</span>
                  <span>{doc.mimeType}</span>
                  {doc.associateName && (
                    <>
                      <span className="text-silver/40">·</span>
                      <span>{doc.associateName}</span>
                    </>
                  )}
                </DialogDescription>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={STATUS_VARIANT[doc.status]}>{doc.status}</Badge>
                {actions}
              </div>
            </header>

            <div className="bg-midnight overflow-hidden flex items-center justify-center">
              <PreviewBody doc={doc} />
            </div>

            <footer className="px-5 py-3 border-t border-navy-secondary flex items-center justify-between gap-3">
              <div className="text-xs text-silver">
                {doc.rejectionReason ? (
                  <span className="text-alert">
                    Rejection reason: {doc.rejectionReason}
                  </span>
                ) : doc.verifiedAt ? (
                  <>
                    Verified
                    {doc.verifierEmail ? ` by ${doc.verifierEmail}` : ''}
                  </>
                ) : (
                  'Awaiting HR review.'
                )}
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewDocumentUrl(doc.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-white px-2 py-1 rounded border border-navy-secondary hover:border-silver/50 transition"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open in new tab
                </a>
                <a
                  href={downloadDocumentUrl(doc.id)}
                  className="inline-flex items-center gap-1.5 text-xs text-navy bg-gold hover:bg-gold-bright px-2.5 py-1 rounded font-medium transition"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
              </div>
            </footer>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ doc }: { doc: DocumentRecord }) {
  const url = previewDocumentUrl(doc.id);
  if (doc.mimeType === 'application/pdf') {
    return (
      <iframe
        src={url}
        title={doc.filename}
        className="w-full h-full bg-white"
        // sandbox lets the PDF viewer run but blocks navigation / popups.
        // PDF.js needs scripts; pure same-origin embeds don't, but Chromium's
        // built-in viewer behaves the same with or without `allow-scripts`.
        sandbox="allow-same-origin allow-scripts allow-popups"
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
      <FileWarning className="h-10 w-10 text-silver/60 mx-auto mb-3" />
      <p className="text-white font-medium">Preview not available</p>
      <p className="text-sm text-silver mt-1">
        This file type ({doc.mimeType}) can't be previewed in-browser. Download
        or open in a new tab to view it.
      </p>
      <p className="sr-only">{isPreviewable(doc.mimeType) ? '' : 'fallback'}</p>
    </div>
  );
}
