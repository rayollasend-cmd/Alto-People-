import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageOff } from '@/components/ui/icons';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui';
import { PLATFORM_OPERATOR_TENANT_ID } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useTenant } from '@/lib/auth';
import { clearMissingProfilePhotos, getProfilePhotoHealth } from '@/lib/orgApi';
import { useConfirm } from '@/lib/confirm';

/**
 * A lost photo renders exactly like no photo — initials, no error — so a
 * storage that drops files looked like "nobody has a photo". HR sees it
 * here instead: uploads that won't survive a redeploy, or photos already
 * gone, with the one action that tidies up. Silent when all is well.
 */
export function PhotoStorageBanner() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const operator = useTenant().id === PLATFORM_OPERATOR_TENANT_ID;
  const [busy, setBusy] = useState(false);
  const { data } = useQuery({
    queryKey: ['profile-photos', 'health'],
    queryFn: getProfilePhotoHealth,
    staleTime: 10 * 60_000,
  });
  if (!data || (data.durable && data.missing === 0)) return null;

  const onClear = async () => {
    if (
      !(await confirm({
        title: `Forget ${data.missing} missing photo${data.missing === 1 ? '' : 's'}?`,
        description:
          'Their files are gone, so they already show initials. Clearing lets each person upload again from Settings, and re-opens the photo step on any onboarding still in progress.',
      }))
    )
      return;
    setBusy(true);
    try {
      const r = await clearMissingProfilePhotos();
      toast.success(`Cleared ${r.cleared} missing photo${r.cleared === 1 ? '' : 's'}.`);
      void qc.invalidateQueries({ queryKey: ['profile-photos'] });
      void qc.invalidateQueries({ queryKey: ['directory'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not clear them.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
    >
      <ImageOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        {!data.durable && (
          <p>
            Photos and documents aren&rsquo;t being kept between deploys — contact support.
            {operator && (
              <>
                {' '}Uploads are on the server&rsquo;s temporary disk: attach a volume
                (<code>UPLOAD_DIR</code>) or switch to S3 storage — see apps/api/STORAGE.md.
              </>
            )}
          </p>
        )}
        {data.missing > 0 && (
          <p>
            {data.missing} of {data.onFile}
            {data.truncated ? '+' : ''} profile photo{data.onFile === 1 ? '' : 's'} on
            record {data.missing === 1 ? 'has' : 'have'} lost {data.missing === 1 ? 'its' : 'their'} file,
            so {data.missing === 1 ? 'that person shows' : 'those people show'} initials.
          </p>
        )}
      </div>
      {data.missing > 0 && (
        <Button size="sm" variant="outline" onClick={() => void onClear()} disabled={busy}>
          {busy ? 'Clearing…' : 'Ask them again'}
        </Button>
      )}
    </div>
  );
}
