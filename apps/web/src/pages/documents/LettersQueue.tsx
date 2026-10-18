import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { approveLetter, declineLetter, letterPdfUrl, listLetters, type LetterStatus, type VerificationLetter } from '@/lib/verificationLettersApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Textarea } from '@/components/ui/Input';

/**
 * HR's letters queue (HR pack 2026-10): verification letters people asked
 * for — approve (the facts are frozen into the letter at that moment) or
 * decline with a reason the person sees.
 */
export function LettersQueue({ canManage }: { canManage: boolean }) {
  const term = useTerm();
  const qc = useQueryClient();
  const [status, setStatus] = useState<LetterStatus>('REQUESTED');
  const [declining, setDeclining] = useState<VerificationLetter | null>(null);
  const [reason, setReason] = useState('');
  const query = useQuery({ queryKey: ['verification-letters', status], queryFn: () => listLetters(status) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['verification-letters'] });
    void qc.invalidateQueries({ queryKey: ['inbox'] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => approveLetter(id),
    onSuccess: () => {
      toast.success('Approved. The person can download it now.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not approve.'),
  });
  const decline = useMutation({
    mutationFn: (l: VerificationLetter) => declineLetter(l.id, reason.trim()),
    onSuccess: () => {
      toast.success('Declined. The person sees your reason.');
      setDeclining(null);
      setReason('');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not decline.'),
  });

  const columns: GridColumn<VerificationLetter>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.associateName ?? '', sortable: true, primary: true, cell: (r) => (
      <>
        <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink>
        <div className="text-xs text-ink-muted">{r.associateEmail}</div>
      </>
    ) },
    { key: 'kind', header: 'Letter', accessor: (r) => (r.kind === 'INCOME' ? 'Employment and income' : 'Employment'), sortable: true, cardMeta: true },
    { key: 'for', header: 'For', accessor: (r) => [r.addressedTo, r.purpose].filter(Boolean).join(' · '), className: 'text-sm text-ink-muted' },
    { key: 'asked', header: 'Asked', accessor: (r) => r.createdAt, sortable: true, searchable: false, className: 'text-xs text-ink-muted', cell: (r) => fmtDate(r.createdAt) },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      cell: (r) =>
        r.status === 'REQUESTED' && canManage ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => approve.mutate(r.id)} loading={approve.isPending}>
              Approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeclining(r)}>
              Decline
            </Button>
          </div>
        ) : r.status === 'APPROVED' ? (
          <Button size="sm" variant="outline" asChild>
            <a href={letterPdfUrl(r.id)} target="_blank" rel="noopener noreferrer">
              PDF
            </a>
          </Button>
        ) : (
          <Badge variant="destructive">Declined</Badge>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <SegmentedControl
        ariaLabel="Letter status"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'REQUESTED', label: 'Waiting' },
          { value: 'APPROVED', label: 'Approved' },
          { value: 'DECLINED', label: 'Declined' },
        ]}
      />
      <Card>
        <CardContent className="p-3">
          <DataGrid<VerificationLetter>
            id="verification-letters"
            caption="Verification letters"
            rows={query.data?.letters ?? []}
            rowKey={(r) => r.id}
            loading={query.isLoading}
            search={{ placeholder: `${term('worker')}…` }}
            urlState={false}
            exportCsv={{ filename: 'verification-letters' }}
            columns={columns}
            empty={{ title: status === 'REQUESTED' ? 'No letters waiting' : 'Nothing here', description: status === 'REQUESTED' ? 'When someone asks for proof of employment or income, it lands here.' : undefined }}
          />
        </CardContent>
      </Card>
      {declining && (
        <Card>
          <CardContent className="space-y-2">
            <div className="text-sm text-ink">Decline {declining.associateName}'s letter</div>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="Why — the person reads this." />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDeclining(null)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => decline.mutate(declining)} loading={decline.isPending} disabled={reason.trim().length < 2}>
                Decline
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
