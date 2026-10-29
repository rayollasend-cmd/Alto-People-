import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * What a chart becomes when it has fewer than four readings: the latest
 * figure and one sentence. Three dots on an axis say less than the number.
 */
export function FewPoints({ title, value, sentence, testId }: { title: string; value: string; sentence: string; testId?: string }) {
  return (
    <Card className="min-w-0" data-testid={testId}>
      <CardContent className="space-y-2 p-4 md:p-5">
        <SectionTitle title={title} />
        <div className="font-display text-[1.75rem] leading-none tabular-nums text-ink">{value}</div>
        <p className="text-sm text-ink-muted">{sentence}</p>
      </CardContent>
    </Card>
  );
}
