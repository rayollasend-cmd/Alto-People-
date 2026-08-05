import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DocumentThumbnails,
  DocumentViewer,
  type ViewableDocument,
} from '@/components/DocumentViewer';

const FRONT: ViewableDocument = {
  id: '00000000-0000-4000-8000-00000000aaaa',
  kind: 'ID',
  filename: 'drivers-license-front.jpg',
  mimeType: 'image/jpeg',
  side: 'FRONT',
  fileAvailable: true,
};
const BACK: ViewableDocument = {
  id: '00000000-0000-4000-8000-00000000bbbb',
  kind: 'ID',
  filename: 'drivers-license-back.jpg',
  mimeType: 'image/jpeg',
  side: 'BACK',
  fileAvailable: true,
};

describe('<DocumentViewer>', () => {
  // The whole point of the change: reviewing an ID must not put a copy of it
  // in the reviewer's Downloads folder. The image is served from the inline
  // endpoint, which responds Content-Disposition: inline with no-store.
  it('renders images from the inline endpoint, not the download URL', () => {
    render(<DocumentViewer documents={[FRONT]} onClose={() => {}} />);
    const img = screen.getByAltText('ID · front');
    expect(img.getAttribute('src')).toBe(
      `/api/documents/${FRONT.id}/download?inline=1`,
    );
  });

  it('still offers an explicit download', () => {
    render(<DocumentViewer documents={[FRONT]} onClose={() => {}} />);
    const link = screen.getByRole('link', { name: /download/i });
    // No inline flag here — this one is meant to save the file.
    expect(link.getAttribute('href')).toBe(`/api/documents/${FRONT.id}/download`);
  });

  // Identity documents are phone photos of small print, and half arrive
  // sideways. Without these a verifier goes back to downloading.
  it('offers zoom and rotate for images', () => {
    render(<DocumentViewer documents={[FRONT]} onClose={() => {}} />);
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(screen.getByLabelText('Rotate 90 degrees')).toBeInTheDocument();
  });

  it('moves between documents and reports position', async () => {
    const user = userEvent.setup();
    render(<DocumentViewer documents={[FRONT, BACK]} onClose={() => {}} />);

    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Next document'));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
    expect(screen.getByAltText('ID · back')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<DocumentViewer documents={[FRONT]} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  // The deploy target's ephemeral disk can leave rows whose blobs are gone.
  // A broken <img> in a compliance screen reads as "no document on file",
  // which is a materially different (and wrong) conclusion.
  it('explains a missing file instead of rendering a broken image', () => {
    render(
      <DocumentViewer
        documents={[{ ...FRONT, fileAvailable: false }]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByAltText('ID · front')).not.toBeInTheDocument();
    expect(screen.getByText(/no longer on the server/i)).toBeInTheDocument();
  });

  it('falls back to a message for file types the browser cannot show', () => {
    render(
      <DocumentViewer
        documents={[{ ...FRONT, mimeType: 'application/zip' }]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/can't be shown in the browser/i)).toBeInTheDocument();
  });
});

describe('<DocumentThumbnails>', () => {
  it('opens the viewer on the document that was clicked', async () => {
    const user = userEvent.setup();
    render(<DocumentThumbnails documents={[FRONT, BACK]} />);

    // Grid only until something is opened.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /view id back/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('shows the empty message when there is nothing to review', () => {
    render(<DocumentThumbnails documents={[]} emptyMessage="Nothing uploaded." />);
    expect(screen.getByText('Nothing uploaded.')).toBeInTheDocument();
  });

  it('disables a thumbnail whose file is gone', () => {
    render(<DocumentThumbnails documents={[{ ...FRONT, fileAvailable: false }]} />);
    expect(screen.getByRole('button', { name: /view id front/i })).toBeDisabled();
  });
});

describe('<DocumentThumbnails> bulk download', () => {
  const ASSOCIATE = '00000000-0000-4000-8000-00000000cccc';

  it('is hidden unless an associate is supplied', () => {
    render(<DocumentThumbnails documents={[FRONT, BACK]} />);
    expect(screen.queryByRole('link', { name: /download all/i })).not.toBeInTheDocument();
  });

  // Scoped to identity documents rather than the associate's whole file:
  // a reviewer working an I-9 wants the four IDs, not the offer letter and
  // every signed policy. Exporting more PII than the task needs is a habit
  // worth designing out.
  it('scopes the archive to the kinds it was given', () => {
    render(
      <DocumentThumbnails
        documents={[FRONT, BACK]}
        bulkDownloadAssociateId={ASSOCIATE}
        bulkDownloadKinds={['ID', 'SSN_CARD']}
      />,
    );
    const href = screen
      .getByRole('link', { name: /download all/i })
      .getAttribute('href')!;
    expect(href).toContain(`associateId=${ASSOCIATE}`);
    expect(href).toContain('kinds=ID%2CSSN_CARD');
  });

  // The count is what's actually retrievable, not the row count — an archive
  // advertising 4 documents that contains 2 is worse than saying 2.
  it('counts only documents whose file is still on the server', () => {
    render(
      <DocumentThumbnails
        documents={[FRONT, { ...BACK, fileAvailable: false }]}
        bulkDownloadAssociateId={ASSOCIATE}
      />,
    );
    expect(screen.getByRole('link', { name: /download all \(1\)/i })).toBeInTheDocument();
    expect(screen.getByText('1 of 2 available')).toBeInTheDocument();
  });

  it('offers nothing to download when every file is gone', () => {
    render(
      <DocumentThumbnails
        documents={[{ ...FRONT, fileAvailable: false }]}
        bulkDownloadAssociateId={ASSOCIATE}
      />,
    );
    expect(screen.queryByRole('link', { name: /download all/i })).not.toBeInTheDocument();
  });
});
