import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Maximize2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { previewDocumentUrl, isPreviewable } from '@/lib/documentsApi';

/**
 * In-site viewer for identity documents.
 *
 * Before this, reviewing a driver's licence or passport meant downloading it —
 * which puts a copy of someone's identity document in the reviewer's Downloads
 * folder, outside the product's retention rules, on every single case. Viewing
 * in place keeps the file on the server; the API already streams it with
 * `Content-Disposition: inline`, a MIME allowlist, `nosniff`, a locked-down CSP
 * and `Cache-Control: no-store`, so nothing is written to disk.
 *
 * Zoom and rotate are not decoration. These are phone photographs of small
 * print — a verifier is reading a document number, an expiry date and a date of
 * birth off them, and half arrive sideways. A viewer without those controls
 * just sends people back to downloading.
 */

export interface ViewableDocument {
  id: string;
  kind: string;
  filename: string;
  mimeType: string;
  side?: 'FRONT' | 'BACK' | null;
  fileAvailable: boolean;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export function DocumentViewer({
  documents,
  startIndex = 0,
  onClose,
}: {
  documents: ViewableDocument[];
  startIndex?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  const doc = documents[index];

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = i + delta;
        if (next < 0 || next >= documents.length) return i;
        return next;
      });
      // A new document starts fresh — carrying a 3× zoom onto the next one
      // lands the reviewer somewhere in the middle of an image with no
      // indication of why.
      setZoom(1);
      setRotation(0);
    },
    [documents.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
      if (e.key === '-') setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));
      if (e.key.toLowerCase() === 'r') setRotation((r) => (r + 90) % 360);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  if (!doc) return null;

  const isImage = doc.mimeType.startsWith('image/');
  const canPreview = doc.fileAvailable && isPreviewable(doc.mimeType);
  const label = `${doc.kind}${doc.side ? ` · ${doc.side.toLowerCase()}` : ''}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Document viewer — ${label}`}
      className="fixed inset-0 z-[100] flex flex-col bg-navy/95 backdrop-blur-sm"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-navy-secondary px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-white">{label}</div>
          <div className="truncate text-2xs text-silver/70">{doc.filename}</div>
        </div>

        {documents.length > 1 && (
          <div className="flex items-center gap-1">
            <ToolButton
              onClick={() => go(-1)}
              disabled={index === 0}
              label="Previous document"
            >
              <ChevronLeft className="h-4 w-4" />
            </ToolButton>
            <span className="min-w-[3.5rem] text-center text-xs tabular-nums text-silver">
              {index + 1} / {documents.length}
            </span>
            <ToolButton
              onClick={() => go(1)}
              disabled={index === documents.length - 1}
              label="Next document"
            >
              <ChevronRight className="h-4 w-4" />
            </ToolButton>
          </div>
        )}

        {canPreview && isImage && (
          <div className="flex items-center gap-1">
            <ToolButton
              onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP))}
              disabled={zoom <= ZOOM_MIN}
              label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </ToolButton>
            <span className="min-w-[3rem] text-center text-xs tabular-nums text-silver">
              {Math.round(zoom * 100)}%
            </span>
            <ToolButton
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP))}
              disabled={zoom >= ZOOM_MAX}
              label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              onClick={() => {
                setZoom(1);
                setRotation(0);
              }}
              label="Reset view"
            >
              <Maximize2 className="h-4 w-4" />
            </ToolButton>
            <ToolButton
              onClick={() => setRotation((r) => (r + 90) % 360)}
              label="Rotate 90 degrees"
            >
              <RotateCw className="h-4 w-4" />
            </ToolButton>
          </div>
        )}

        {/* Download stays available — some reviews genuinely need the file —
            but it is no longer the ONLY way to look at the document. */}
        <a
          href={`/api/documents/${doc.id}/download`}
          className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-silver/80 transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
        <ToolButton onClick={onClose} label="Close viewer">
          <X className="h-4 w-4" />
        </ToolButton>
      </div>

      {/* Stage */}
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        {!doc.fileAvailable ? (
          <Message>
            The underlying file is no longer on the server. Ask the associate to
            re-upload this document.
          </Message>
        ) : !canPreview ? (
          <Message>
            This file type can&apos;t be shown in the browser. Use Download to
            open it.
          </Message>
        ) : isImage ? (
          <img
            src={previewDocumentUrl(doc.id)}
            alt={label}
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transition: 'transform 120ms ease-out',
            }}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          // PDFs render in the browser's own viewer. The API's inline CSP
          // (`default-src 'none'`) keeps a hostile PDF from reaching out.
          <iframe
            src={previewDocumentUrl(doc.id)}
            title={label}
            className="h-full w-full rounded border border-navy-secondary bg-white"
          />
        )}
      </div>

      {/* Filmstrip — front/back of the same ID is the common case, and
          flipping between them is most of what a verifier does. */}
      {documents.length > 1 && (
        <div className="flex gap-2 overflow-x-auto border-t border-navy-secondary px-4 py-2">
          {documents.map((d, i) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                setIndex(i);
                setZoom(1);
                setRotation(0);
              }}
              aria-label={`View ${d.kind}${d.side ? ` ${d.side}` : ''}`}
              aria-current={i === index}
              className={cn(
                'h-14 w-20 shrink-0 overflow-hidden rounded border transition-colors',
                i === index
                  ? 'border-gold'
                  : 'border-navy-secondary hover:border-silver/40',
              )}
            >
              {d.fileAvailable && d.mimeType.startsWith('image/') ? (
                <img
                  src={previewDocumentUrl(d.id)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-2xs text-silver">
                  {d.fileAvailable ? 'PDF' : 'missing'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded p-1.5 text-silver/80 transition-colors hover:text-gold disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      {children}
    </button>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-sm text-center text-sm text-silver">{children}</p>
  );
}

/**
 * Thumbnail grid that opens the viewer. Shared so the E-Verify and I-9 screens
 * present identity documents the same way — they're the same documents, and
 * having two different treatments two tabs apart is how the shift tiles drifted.
 */
export function DocumentThumbnails({
  documents,
  emptyMessage = 'No documents uploaded.',
}: {
  documents: ViewableDocument[];
  emptyMessage?: string;
}) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  if (documents.length === 0) {
    return <p className="text-xs text-warning">{emptyMessage}</p>;
  }

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {documents.map((d, i) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => setOpenAt(i)}
              disabled={!d.fileAvailable}
              // Explicit name: without it the accessible name is scraped from
              // the tile's own text ("ID", "front"), which tells a screen
              // reader what the thing IS but not that activating it opens it.
              aria-label={`View ${d.kind}${d.side ? ` ${d.side.toLowerCase()}` : ''}`}
              className={cn(
                'block w-full overflow-hidden rounded border text-left transition-colors',
                d.fileAvailable
                  ? 'border-navy-secondary hover:border-gold/60'
                  : 'cursor-not-allowed border-alert/40 bg-alert/5',
              )}
            >
              <div className="flex aspect-[3/2] items-center justify-center bg-navy-secondary">
                {!d.fileAvailable ? (
                  <span className="px-2 text-center text-2xs leading-tight text-alert">
                    File missing on server
                  </span>
                ) : d.mimeType.startsWith('image/') ? (
                  <img
                    src={previewDocumentUrl(d.id)}
                    alt={`${d.kind}${d.side ? ` ${d.side}` : ''}`}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="text-xs text-silver">PDF</span>
                )}
              </div>
              <div className="px-2 py-1.5">
                <div className="truncate text-xs text-white">{d.kind}</div>
                <div className="text-2xs text-silver">
                  {d.side ? d.side.toLowerCase() : 'document'}
                  {!d.fileAvailable && (
                    <> · <span className="text-alert">re-upload required</span></>
                  )}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      {openAt !== null && (
        <DocumentViewer
          documents={documents}
          startIndex={openAt}
          onClose={() => setOpenAt(null)}
        />
      )}
    </>
  );
}
