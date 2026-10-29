import type * as React from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/Card';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { execHref, useExecFrame } from '@/lib/executiveApi';

/** One card of the pulse: a title, what it answers, a link to the desk that works it, the body. */
export function PulseCard({ title, description, link, children, testId, className }: { title: string; description?: string; link?: { to: string; label: string }; children: React.ReactNode; testId?: string; className?: string }) {
  // An executive page opens in the frame the chairman came with (execHref
  // leaves every other page's URL alone).
  const frame = useExecFrame();
  return (
    <Card className={className ? `min-w-0 ${className}` : 'min-w-0'} data-testid={testId}>
      <CardContent className="space-y-4 p-4 md:p-5">
        <SectionTitle
          wrap
          title={title}
          description={description}
          trailing={
            link ? (
              <Link to={execHref(link.to, frame)} className="inline-flex min-h-8 items-center text-xs2 text-accent hover:underline coarse:min-h-11">
                {link.label}
              </Link>
            ) : undefined
          }
        />
        {children}
      </CardContent>
    </Card>
  );
}

/** The attendance kinds the API sends, as the words a person says. */
export const ATTENDANCE_KINDS = ['NO_CALL_NO_SHOW', 'CALL_OUT', 'LATE', 'EARLY_OUT'] as const;
export type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];
export const isAttendanceKind = (k: string): k is AttendanceKind => (ATTENDANCE_KINDS as readonly string[]).includes(k);
