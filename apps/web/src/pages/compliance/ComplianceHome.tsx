import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { I9Tab } from './I9Tab';
import { BackgroundTab } from './BackgroundTab';
import { J1Tab } from './J1Tab';
import { cn } from '@/lib/cn';

type Tab = 'i9' | 'background' | 'j1';

export function ComplianceHome() {
  const { can } = useAuth();
  const canManage = can('manage:compliance');
  const [tab, setTab] = useState<Tab>('i9');

  const TABS: Array<{ value: Tab; label: string }> = [
    { value: 'i9', label: 'I-9 verification' },
    { value: 'background', label: 'Background checks' },
    { value: 'j1', label: 'J-1 program' },
  ];

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Compliance
        </h1>
        <p className="text-silver">
          {canManage
            ? 'Track I-9, background checks, and J-1 program status across associates.'
            : 'Read-only view of compliance state.'}
        </p>
      </header>

      <div role="tablist" className="flex flex-wrap gap-2 mb-5 border-b border-navy-secondary">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={cn(
              'px-3 py-2 text-sm border-b-2 -mb-px transition',
              tab === t.value
                ? 'border-gold text-gold'
                : 'border-transparent text-silver hover:text-white'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'i9' && <I9Tab canManage={canManage} />}
      {tab === 'background' && <BackgroundTab canManage={canManage} />}
      {tab === 'j1' && <J1Tab canManage={canManage} />}
    </div>
  );
}
