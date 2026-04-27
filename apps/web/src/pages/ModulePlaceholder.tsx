import type { ModuleKey } from '@/lib/modules';
import { PageHeader } from '@/components/ui/PageHeader';

interface ModulePlaceholderProps {
  moduleKey: ModuleKey;
  title: string;
  description: string;
}

export function ModulePlaceholder({
  moduleKey,
  title,
  description,
}: ModulePlaceholderProps) {
  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader title={title} subtitle={description} />

      <div className="bg-navy border border-navy-secondary rounded-lg p-8 text-center">
        <div className="inline-block px-3 py-1 rounded-full bg-gold/10 border border-gold/30 text-gold text-xs uppercase tracking-widest mb-4">
          Phase 1 placeholder
        </div>
        <p className="font-display text-2xl text-white mb-2">
          Module not yet implemented
        </p>
        <p className="text-silver max-w-md mx-auto text-sm leading-relaxed">
          The <code className="text-gold/90">{moduleKey}</code> module is
          scaffolded for navigation. Functionality lands in a later phase per
          the project roadmap.
        </p>
      </div>
    </div>
  );
}
