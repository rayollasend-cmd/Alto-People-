import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type {
  ClientSummary,
  OnboardingTemplate,
} from '@alto-people/shared';
import {
  deleteTemplate,
  listClients,
  listTemplates,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const TRACK_VARIANT: Record<string, 'default' | 'accent' | 'pending'> = {
  STANDARD: 'default',
  J1: 'accent',
  CLIENT_SPECIFIC: 'pending',
};

export function TemplatesList() {
  const { can } = useAuth();
  const canManage = can('manage:onboarding');

  const [templates, setTemplates] = useState<OnboardingTemplate[] | null>(null);
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OnboardingTemplate | null>(null);

  const refresh = async () => {
    try {
      setError(null);
      const [t, c] = await Promise.all([listTemplates(), listClients()]);
      setTemplates(t.templates);
      setClients(c.clients);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const clientName = useMemo(() => {
    const m = new Map<string, string>();
    if (clients) for (const c of clients) m.set(c.id, c.name);
    return (id: string | null): string => (id ? (m.get(id) ?? 'Unknown client') : 'Global');
  }, [clients]);

  const grouped = useMemo(() => {
    const out: Record<string, OnboardingTemplate[]> = {};
    if (templates) {
      for (const t of templates) {
        (out[t.track] ??= []).push(t);
      }
    }
    return out;
  }, [templates]);

  const onDelete = (t: OnboardingTemplate) => {
    if (deletingId) return;
    setDeleteTarget(t);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingId(deleteTarget.id);
    try {
      await deleteTemplate(deleteTarget.id);
      toast.success(`Deleted "${deleteTarget.name}"`);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'template_in_use') {
        toast.error('Template in use', { description: err.message });
      } else {
        toast.error(err instanceof ApiError ? err.message : 'Delete failed');
      }
    } finally {
      setDeletingId(null);
    }
  };

  if (!canManage) {
    return (
      <div className="max-w-3xl mx-auto">
        <div
          className="p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          You don't have permission to manage onboarding templates.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-4">
        <Link
          to="/onboarding"
          className="text-sm text-silver hover:text-gold inline-block"
        >
          ← Applications
        </Link>
      </div>

      <PageHeader
        title="Onboarding templates"
        subtitle="The checklists HR picks from when inviting an associate."
        primaryAction={
          <Link to="/onboarding/templates/new">
            <Button>
              <Plus className="h-4 w-4" />
              New template
            </Button>
          </Link>
        }
      />

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {!templates && (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {templates && templates.length === 0 && !error && (
        <EmptyState
          icon={LayoutTemplate}
          title="No templates yet"
          description='Click "New template" to create the first onboarding checklist.'
          action={
            <Link to="/onboarding/templates/new">
              <Button>
                <Plus className="h-4 w-4" />
                New template
              </Button>
            </Link>
          }
        />
      )}

      {templates && templates.length > 0 && (
        <div className="space-y-6">
          {Object.entries(grouped).map(([track, list]) => (
            <section key={track}>
              <h2 className="text-xs uppercase tracking-widest text-silver mb-2">
                {TRACK_LABEL[track] ?? track}
                <span className="ml-2 tabular-nums text-silver/60">
                  {list.length}
                </span>
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {list.map((t) => (
                  <Card
                    key={t.id}
                    className={cn(
                      'p-4 hover:border-gold/40 transition-colors group'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <Link
                        to={`/onboarding/templates/${t.id}`}
                        className="text-white font-medium group-hover:text-gold truncate"
                      >
                        {t.name}
                      </Link>
                      <Badge variant={TRACK_VARIANT[t.track] ?? 'default'}>
                        {TRACK_LABEL[t.track] ?? t.track}
                      </Badge>
                    </div>
                    <div className="text-xs text-silver flex items-center gap-1.5 mb-3">
                      <Globe className="h-3 w-3" />
                      {clientName(t.clientId)}
                    </div>
                    <div className="text-xs text-silver/80 mb-3">
                      <span className="text-white tabular-nums">{t.tasks.length}</span>{' '}
                      task{t.tasks.length === 1 ? '' : 's'}:{' '}
                      <span className="text-silver/70">
                        {t.tasks
                          .slice(0, 3)
                          .map((tk) => tk.title)
                          .join(' · ')}
                        {t.tasks.length > 3 && (
                          <span className="text-silver/50">
                            {' '}
                            + {t.tasks.length - 3} more
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDelete(t)}
                        loading={deletingId === t.id}
                        title="Delete template"
                        className="text-alert hover:text-alert"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                      <Link to={`/onboarding/templates/${t.id}`}>
                        <Button variant="outline" size="sm">
                          Edit
                        </Button>
                      </Link>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={
          deleteTarget ? `Delete template "${deleteTarget.name}"?` : 'Delete template'
        }
        description="Any in-flight applications using this track will keep their existing checklist — only future applications are affected."
        confirmLabel="Delete template"
        destructive
        busy={deletingId !== null}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
