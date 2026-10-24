import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pentagon, ShieldAlert, Undo2, Users } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { SiteSafetyZoneSummary, ZoneShape } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDateTime } from '@/lib/format';
import { boundsOf, closesPolygon, polygonValid, round1, shapeLabel, shapePoints, type Point } from '@/lib/robotZones';
import { createSafetyZone, listRobots, listSafetyZones, setZoneOccupied, updateSafetyZone } from '@/lib/robotsApi';
import { useOrgSites } from '@/lib/useOrgSites';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const shapeLine = (z: SiteSafetyZoneSummary) => shapeLabel(z.shape);

type DrawMode = 'polygon' | 'rect';
const MODES: { value: DrawMode; label: string }[] = [
  { value: 'polygon', label: 'Polygon' },
  { value: 'rect', label: 'Rectangle' },
];

/**
 * The site map as a drawing surface: the zones that exist, and the polygon
 * being drawn. A click adds a vertex; a click on the first vertex (or
 * "Close shape") closes it; a vertex can be dragged after it is placed.
 * Units are the commissioning map's own.
 */
/** A round grid step for a map `span` units wide: about ten lines (1, 2, 5 × 10ⁿ). */
export function gridStep(span: number): number {
  const raw = Math.max(span, 1) / 10;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export function ZoneCanvas({
  zones,
  draft,
  onDraftChange,
  onClose,
  drawing,
  robots = [],
}: {
  zones: SiteSafetyZoneSummary[];
  draft: Point[];
  onDraftChange: (next: Point[]) => void;
  onClose: () => void;
  drawing: boolean;
  /** Robots at this site at their last reading, drawn as dots for reference. */
  robots?: { id: string; name: string; x: number; y: number }[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const b = useMemo(
    () =>
      boundsOf([
        ...zones.map((z) => z.shape),
        ...(draft.length ? [{ type: 'polygon' as const, points: draft.length >= 3 ? draft : [...draft, draft[0]!, draft[0]!] }] : []),
        ...robots.map((r) => ({ type: 'rect' as const, x: r.x, y: r.y, w: 0, h: 0 })),
      ]),
    [zones, draft, robots],
  );
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const tolerance = Math.max(w, h) * 0.03;
  // A light grid with map-unit ticks, so "click the map" has a reference
  // (it was a blank rectangle — F500 G2).
  const step = gridStep(Math.max(w, h));
  const unit = Math.max(w, h);
  const lines = (lo: number, hi: number) => {
    const out: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
  };

  const toMap = (e: { clientX: number; clientY: number }): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = b.minX + ((e.clientX - rect.left) / Math.max(1, rect.width)) * w;
    const y = b.minY + ((e.clientY - rect.top) / Math.max(1, rect.height)) * h;
    return [round1(x), round1(y)];
  };

  return (
    <div className="space-y-2">
      <svg
        ref={svgRef}
        viewBox={`${b.minX} ${b.minY} ${w} ${h}`}
        className={`aspect-square w-full max-w-xl rounded-lg border border-line bg-surface-raised/40 ${drawing ? 'cursor-crosshair' : ''}`}
        role="img"
        aria-label={drawing ? 'Site map: click to add a vertex, click the first vertex to close the zone' : 'Site map with its safety zones'}
        data-testid="zone-canvas"
        onClick={(e) => {
          if (!drawing || dragging !== null) return;
          const p = toMap(e);
          if (closesPolygon(draft, p, tolerance)) {
            onClose();
            return;
          }
          onDraftChange([...draft, p]);
        }}
        onPointerMove={(e) => {
          if (dragging === null) return;
          const p = toMap(e);
          onDraftChange(draft.map((v, i) => (i === dragging ? p : v)));
        }}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        <g aria-hidden="true" data-testid="zone-grid">
          {lines(b.minX, b.maxX).map((x) => (
            <g key={`x${x}`}>
              <line x1={x} x2={x} y1={b.minY} y2={b.maxY} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={x + unit * 0.006} y={b.minY + unit * 0.03} fontSize={unit * 0.022} className="fill-ink-muted">
                {x}
              </text>
            </g>
          ))}
          {lines(b.minY, b.maxY).map((y) => (
            <g key={`y${y}`}>
              <line y1={y} y2={y} x1={b.minX} x2={b.maxX} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {y !== b.minY && (
                <text x={b.minX + unit * 0.006} y={y - unit * 0.006} fontSize={unit * 0.022} className="fill-ink-muted">
                  {y}
                </text>
              )}
            </g>
          ))}
        </g>
        {robots.map((r) => (
          <g key={r.id} data-testid={`robot-dot-${r.id}`}>
            <circle cx={r.x} cy={r.y} r={unit * 0.012} className="fill-accent stroke-surface" strokeWidth={unit * 0.003} />
            <text x={r.x + unit * 0.018} y={r.y + unit * 0.008} fontSize={unit * 0.026} className="fill-ink">
              {r.name}
            </text>
          </g>
        ))}
        {zones.map((z) => (
          <g key={z.id}>
            <polygon points={shapePoints(z.shape)} className={z.guestOccupied ? 'fill-alert/25 stroke-alert' : 'fill-success/15 stroke-success'} strokeWidth={Math.max(w, h) * 0.005} vectorEffect="non-scaling-stroke" />
            <text x={labelX(z.shape)} y={labelY(z.shape)} fontSize={Math.max(w, h) * 0.035} className="fill-ink" textAnchor="middle">
              {z.name}
            </text>
          </g>
        ))}
        {draft.length > 0 && (
          <g>
            <polyline points={draft.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" className="stroke-gold" strokeWidth={Math.max(w, h) * 0.006} strokeDasharray={`${Math.max(w, h) * 0.015} ${Math.max(w, h) * 0.01}`} />
            {draft.map(([x, y], i) => (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={Math.max(w, h) * (i === 0 ? 0.02 : 0.014)}
                className={i === 0 ? 'fill-gold stroke-ink cursor-pointer' : 'fill-surface stroke-gold cursor-move'}
                strokeWidth={Math.max(w, h) * 0.004}
                data-testid={`vertex-${i}`}
                onPointerDown={(e) => {
                  if (i === 0 && draft.length >= 3) return; // the first vertex closes on click
                  e.stopPropagation();
                  setDragging(i);
                }}
                onClick={(e) => {
                  if (i === 0 && draft.length >= 3) {
                    e.stopPropagation();
                    onClose();
                  }
                }}
              />
            ))}
          </g>
        )}
      </svg>
      <p className="text-xs2 text-ink-muted">Grid every {step} map units{robots.length ? ' · dots are robots at their last reading' : ''}.</p>
    </div>
  );
}

function labelX(shape: ZoneShape): number {
  if (shape.type === 'rect') return shape.x + shape.w / 2;
  return shape.points.reduce((s, p) => s + p[0], 0) / shape.points.length;
}
function labelY(shape: ZoneShape): number {
  if (shape.type === 'rect') return shape.y + shape.h / 2;
  return shape.points.reduce((s, p) => s + p[1], 0) / shape.points.length;
}

/**
 * Brief 3-1 — a site's safety zones. While a zone is marked occupied by
 * guests, no robot operates inside it (the shift gate and the assignment
 * engine both read this). A supervisor flips the switch from the floor;
 * an administrator draws the zones.
 */
export function SiteSafetyZones() {
  const { locationId = '' } = useParams();
  const { can } = useAuth();
  const canManage = can('manage:org');
  const canFloor = can('manage:scheduling');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['robots', 'zones', locationId], queryFn: () => listSafetyZones(locationId), enabled: !!locationId });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['robots', 'zones', locationId] });
  const occupy = useMutation({
    mutationFn: ({ id, occupied }: { id: string; occupied: boolean }) => setZoneOccupied(id, occupied),
    onSuccess: (z) => {
      toast.success(z.guestOccupied ? `${z.name}: robots keep out until it is cleared.` : `${z.name}: clear for robots.`);
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not update the zone.')),
  });
  const allow = useMutation({
    mutationFn: ({ id, allowed }: { id: string; allowed: boolean }) => updateSafetyZone(id, { robotsAllowedWhenOccupied: allowed }),
    onSuccess: () => void invalidate(),
    onError: (e) => toast.error(err(e, 'Could not update the zone.')),
  });
  const [name, setName] = useState('');
  const [mode, setMode] = useState<DrawMode>('polygon');
  const [rect, setRect] = useState({ x: '0', y: '0', w: '10', h: '10' });
  const [draft, setDraft] = useState<Point[]>([]);
  const [closed, setClosed] = useState(false);
  const shape = (): ZoneShape =>
    mode === 'rect' ? { type: 'rect', x: Number(rect.x), y: Number(rect.y), w: Number(rect.w), h: Number(rect.h) } : { type: 'polygon', points: draft };
  const shapeReady = mode === 'rect' ? Number(rect.w) > 0 && Number(rect.h) > 0 : closed && polygonValid(draft);
  const create = useMutation({
    mutationFn: () => createSafetyZone(locationId, { name: name.trim(), shape: shape() }),
    onSuccess: () => {
      toast.success('Zone added.');
      setName('');
      setDraft([]);
      setClosed(false);
      void invalidate();
    },
    onError: (e) => toast.error(err(e, 'Could not add the zone.')),
  });
  const zones = q.data?.zones ?? [];
  const occupied = zones.filter((z) => z.guestOccupied).length;
  const navigate = useNavigate();
  // The page names its site, and switches to another (F500 G2: "Robots ›
  // Safety zones" never said which building).
  const sites = useOrgSites(true);
  const siteName = sites?.find((x) => x.id === locationId)?.name ?? null;
  const fleet = useQuery({ queryKey: ['robots', 'list'], queryFn: listRobots, staleTime: 60_000 });
  const robotsHere = useMemo(
    () =>
      (fleet.data?.robots ?? [])
        .filter((r) => r.site?.id === locationId && r.latest?.x != null && r.latest?.y != null)
        .map((r) => ({ id: r.id, name: r.name, x: r.latest!.x!, y: r.latest!.y! })),
    [fleet.data, locationId],
  );

  return (
    <ListTemplate
      title={siteName ? `Safety zones · ${siteName}` : 'Safety zones'}
      topbarTitle="Safety zones"
      subtitle="Where guests gather on this site's map. While a zone is occupied, no robot operates inside it."
      breadcrumbs={[{ label: 'Robots', to: '/robots' }, ...(siteName ? [{ label: siteName }] : []), { label: 'Safety zones' }]}
      filters={
        sites && sites.length > 1 ? (
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            Site
            <Select size="sm" className="w-full sm:w-64" value={locationId} onChange={(e) => navigate(`/robots/sites/${e.target.value}/zones`)} aria-label="Site">
              {sites.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </label>
        ) : undefined
      }
      summary={
        q.data ? (
          <p className="text-sm text-ink-muted">
            {zones.length} zone{zones.length === 1 ? '' : 's'} · {occupied} occupied right now
          </p>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="the safety zones" query={q} />
      ) : q.isPending ? (
        <Skeleton className="h-40" />
      ) : zones.length === 0 ? (
        <EmptyState icon={ShieldAlert} title="No zones yet" description={canManage ? 'Draw the first zone below: the lobby bar, the pool deck, a banquet floor.' : 'An administrator draws the zones for this site.'} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {zones.map((z) => (
            <li key={z.id} className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium text-ink">{z.name}</div>
                  <div className="text-xs text-ink-muted">{shapeLine(z)}</div>
                  {z.guestOccupied && z.occupiedSince && <div className="text-xs2 text-ink-muted">Occupied since {fmtDateTime(z.occupiedSince)}</div>}
                </div>
                <Badge variant={z.guestOccupied ? (z.robotsAllowedWhenOccupied ? 'pending' : 'destructive') : 'success'}>{z.guestOccupied ? (z.robotsAllowedWhenOccupied ? 'Occupied · robots allowed' : 'Occupied · robots keep out') : 'Clear'}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canFloor && (
                  <Button size="xs" variant={z.guestOccupied ? 'outline' : 'secondary'} onClick={() => occupy.mutate({ id: z.id, occupied: !z.guestOccupied })} loading={occupy.isPending}>
                    <Users className="h-3.5 w-3.5" />
                    {z.guestOccupied ? 'Mark clear' : 'Guests are here'}
                  </Button>
                )}
                {canManage && (
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    <input type="checkbox" className="h-5 w-5 accent-gold" checked={z.robotsAllowedWhenOccupied} onChange={(e) => allow.mutate({ id: z.id, allowed: e.target.checked })} />
                    Robots may operate while occupied
                  </label>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <Card className="mt-5">
          <CardContent className="space-y-3">
            <SectionTitle title="Add a zone" description="Draw it on the commissioning map, in its units: a polygon around the lobby bar, or a rectangle by its numbers." />
            <SegmentedControl ariaLabel="Zone shape" options={MODES} value={mode} onChange={(m) => { setMode(m); setDraft([]); setClosed(false); }} />
            {mode === 'polygon' ? (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <ZoneCanvas zones={zones} robots={robotsHere} draft={draft} drawing={!closed} onDraftChange={(next) => setDraft(next)} onClose={() => setClosed(true)} />
                <div className="space-y-3">
                  <Field label="Name" required>{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pool deck" />}</Field>
                  <p className="text-xs text-ink-muted" aria-live="polite">
                    {draft.length === 0
                      ? 'Click the map to place the first corner.'
                      : closed
                        ? `${draft.length} corners, closed. Drag a corner to adjust it, or add the zone.`
                        : draft.length < 3
                          ? `${draft.length} of at least 3 corners.`
                          : `${draft.length} corners. Click the first corner, or Close shape, to finish.`}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => setClosed(true)} disabled={closed || !polygonValid(draft)}>
                      <Pentagon className="h-3.5 w-3.5" />
                      Close shape
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft((d) => d.slice(0, -1)); setClosed(false); }} disabled={draft.length === 0}>
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo corner
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => { setDraft([]); setClosed(false); }} disabled={draft.length === 0}>
                      Clear
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-5">
                <Field label="Name" required className="sm:col-span-1">{(fp) => <Input {...fp} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pool deck" />}</Field>
                {(['x', 'y', 'w', 'h'] as const).map((k) => (
                  <Field key={k} label={k === 'w' ? 'Width' : k === 'h' ? 'Height' : k.toUpperCase()}>{(fp) => <Input {...fp} type="number" value={rect[k]} onChange={(e) => setRect((r) => ({ ...r, [k]: e.target.value }))} />}</Field>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || !shapeReady}>
                Add zone
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </ListTemplate>
  );
}
