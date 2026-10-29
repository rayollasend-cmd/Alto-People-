import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { FileText } from '@/components/ui/icons';
import { execHref, type ExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/** The page's way to the board packs, on the same frame (the pack for this period is built there). */
export function BoardPackLink({ frame }: { frame: Pick<ExecFrame, 'period' | 'compare'> }) {
  const { t } = useI18n();
  return (
    <Button asChild size="sm" variant="secondary">
      <Link to={execHref('/executive/board-packs', frame)} data-testid="exec-board-pack-link">
        <FileText className="h-4 w-4" aria-hidden="true" />
        {t('execPortal.boardPack')}
      </Link>
    </Button>
  );
}
