import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * A tab only claims `aria-controls` for a panel that is in the document.
 * Strips that switch a view without a TabsContent (the live board, a
 * status filter) used to point the selected tab at an id that never
 * existed — a critical axe finding on three admin pages.
 */
describe('Tabs', () => {
  it('wires the selected tab to its mounted panel and nothing else', () => {
    render(
      <Tabs value="live" onValueChange={vi.fn()}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
        </TabsList>
        <TabsContent value="live">Board</TabsContent>
        <TabsContent value="queue">Queue rows</TabsContent>
      </Tabs>,
    );
    const live = screen.getByRole('tab', { name: 'Live', selected: true });
    const panel = screen.getByRole('tabpanel', { name: 'Live' });
    expect(live).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', live.id);
    // The queue panel is not mounted, so its tab points at nothing.
    expect(screen.getByRole('tab', { name: 'Queue' })).not.toHaveAttribute('aria-controls');
    expect(screen.queryByText('Queue rows')).not.toBeInTheDocument();
  });

  it('a strip that switches a view without panels points at nothing', () => {
    render(
      <Tabs value="live" onValueChange={vi.fn()}>
        <TabsList>
          <TabsTrigger value="live">Live</TabsTrigger>
          <TabsTrigger value="queue">Queue</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Live', selected: true })).not.toHaveAttribute('aria-controls');
    expect(screen.getByRole('tab', { name: 'Queue' })).not.toHaveAttribute('aria-controls');
  });
});
