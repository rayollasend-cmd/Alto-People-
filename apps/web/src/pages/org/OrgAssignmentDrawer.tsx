import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AssociateOrgSummary, CostCenter, Department, JobProfile } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import {
  assignOrgFields,
  listAssociateHistory,
  listCostCenters,
  listDepartments,
  listJobProfiles,
  listOrgAssociates,
  type AssociateHistoryEntry,
} from '@/lib/orgApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Field,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * One person's org assignment — manager, department, cost center, job
 * profile — with its effective-dated history. It used to live on a People
 * tab of Departments & job profiles, a second list of everyone beside
 * /people (F500 G1: one person, one home). A person's record and the
 * People directory open it with `/org?tab=people&associateId=…` (kept as a
 * deep link) or mount <OrgAssignmentDrawer> directly.
 */
export function OrgAssignmentDrawer({
  associateId,
  canManage,
  onClose,
  onSaved,
}: {
  associateId: string | null;
  canManage: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ['org', 'assignment', associateId],
    enabled: !!associateId,
    queryFn: async () => {
      const [a, d, c, j] = await Promise.all([
        listOrgAssociates(undefined, { id: associateId!, former: true }),
        listDepartments(),
        listCostCenters(),
        listJobProfiles(),
      ]);
      return { associate: a.associates[0] ?? null, departments: d.departments, costCenters: c.costCenters, jobProfiles: j.jobProfiles };
    },
  });
  const associate = data.data?.associate ?? null;
  return (
    <Drawer open={!!associateId} onOpenChange={(o) => !o && onClose()} width="max-w-md">
      {associateId && data.isLoading && (
        <>
          <DrawerHeader>
            <DrawerTitle>Org assignment</DrawerTitle>
          </DrawerHeader>
          <DrawerBody>
            <SkeletonRows count={4} rowHeight="h-10" />
          </DrawerBody>
        </>
      )}
      {associateId && !data.isLoading && !associate && (
        <>
          <DrawerHeader>
            <DrawerTitle>Org assignment</DrawerTitle>
          </DrawerHeader>
          <DrawerBody>
            <EmptyState
              size="sm"
              title={data.isError ? 'Could not load this person' : 'Not in your reach'}
              description={data.isError ? 'Try again in a moment.' : 'This person is outside the sites you can see, or no longer on file.'}
              action={
                data.isError ? (
                  <Button size="sm" variant="outline" onClick={() => void data.refetch()}>
                    Retry
                  </Button>
                ) : undefined
              }
            />
          </DrawerBody>
        </>
      )}
      {associate && data.data && (
        <PersonOrgDrawer
          key={associate.id}
          associate={associate}
          canManage={canManage}
          departments={data.data.departments}
          costCenters={data.data.costCenters}
          jobProfiles={data.data.jobProfiles}
          onClose={onClose}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['org'] });
            onSaved?.();
            onClose();
          }}
        />
      )}
    </Drawer>
  );
}

function PersonOrgDrawer({
  associate,
  canManage,
  departments,
  costCenters,
  jobProfiles,
  onClose,
  onSaved,
}: {
  associate: AssociateOrgSummary;
  canManage: boolean;
  departments: Department[];
  costCenters: CostCenter[];
  jobProfiles: JobProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [manager, setManager] = useState<PickedAssociate | null>(
    associate.managerId
      ? { id: associate.managerId, name: associate.managerName ?? 'Current manager' }
      : null,
  );
  const [departmentId, setDepartmentId] = useState(associate.departmentId ?? '');
  const [costCenterId, setCostCenterId] = useState(associate.costCenterId ?? '');
  const [jobProfileId, setJobProfileId] = useState(associate.jobProfileId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyQuery = useQuery({
    queryKey: ['org', 'associate-history', associate.id],
    queryFn: () => listAssociateHistory(associate.id),
  });
  const history: AssociateHistoryEntry[] | null = historyQuery.data?.history ?? null;
  const historyError = historyQuery.error
    ? historyQuery.error instanceof ApiError
      ? historyQuery.error.message
      : 'Could not load history.'
    : null;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await assignOrgFields(associate.id, {
        managerId: manager?.id ?? null,
        departmentId: departmentId || null,
        costCenterId: costCenterId || null,
        jobProfileId: jobProfileId || null,
      });
      toast.success('Org assignment updated.');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar
            src={associate.photoUrl}
            name={`${associate.firstName} ${associate.lastName}`}
            email={associate.email}
            size="md"
          />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {associate.firstName} {associate.lastName}
            </DrawerTitle>
            <DrawerDescription className="truncate">
              {associate.email}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3">
          <Field label="Manager">
            {() =>
              canManage ? (
                <AssociatePicker
                  value={manager}
                  onChange={(v) => {
                    if (v && v.id === associate.id) {
                      toast.error('An associate cannot manage themselves.');
                      return;
                    }
                    setManager(v);
                  }}
                  placeholder="Search for a manager…"
                />
              ) : (
                <div className="rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm text-ink">
                  {manager?.name ?? '—'}
                </div>
              )
            }
          </Field>
          <Field label="Department">
            {(p) => (
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cost center">
            {(p) => (
              <Select
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {costCenters.map((c) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Job profile">
            {(p) => (
              <Select
                value={jobProfileId}
                onChange={(e) => setJobProfileId(e.target.value)}
                disabled={!canManage}
                {...p}
              >
                <option value="">—</option>
                {jobProfiles.map((j) => (
                  <option key={j.id} value={j.id}>{j.code} · {j.title}</option>
                ))}
              </Select>
            )}
          </Field>
          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="pt-3 border-t border-navy-secondary">
            <div className="text-2xs uppercase tracking-widest text-silver/80 mb-2">
              Effective changes
            </div>
            {historyError && (
              <ErrorBanner className="mb-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span>{historyError}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void historyQuery.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            )}
            {history === null && !historyError && (
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            )}
            {history?.length === 0 && (
              <EmptyState size="sm" title={"No history yet."} />
            )}
            {history && history.length > 0 && (
              <ol className="space-y-2 text-xs">
                {history.map((h) => {
                  const isCurrent = h.effectiveTo === null;
                  return (
                    <li
                      key={h.id}
                      className="flex items-start gap-3 border-l-2 pl-3 border-navy-secondary data-[current=true]:border-gold"
                      data-current={isCurrent}
                    >
                      <div className="min-w-0">
                        <div className="text-ink tabular-nums">
                          {fmtDateTime(h.effectiveFrom)}
                          {isCurrent ? (
                            <Badge variant="default" className="ml-2">Current</Badge>
                          ) : null}
                        </div>
                        <div className="text-silver mt-0.5">
                          {h.reason ?? '—'}
                          {h.actorEmail ? ` · ${h.actorEmail}` : ''}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        {canManage && (
          <Button onClick={submit} loading={submitting}>
            Save assignment
          </Button>
        )}
      </DrawerFooter>
    </>
  );
}
