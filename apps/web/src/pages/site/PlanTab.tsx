/**
 * SITE PLAN (#471–478).
 *
 * There is no tile server, so this is not a map of the world: it is a plan of
 * the project's OWN records in an equirectangular projection — exclusion
 * zones, survey control, boreholes, buried service routes, strikes, located
 * gate reads and environmental events. Pan by dragging, zoom with the
 * buttons, toggle layers on the left.
 *
 * A project whose records carry no coordinates gets an honest empty state
 * naming what would appear here, not an arbitrary centre point.
 */
import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card, CardBody, EmptyState } from "../../ui";
import { IconLocation, IconZoomIn, IconZoomOut } from "../../ui/icons";
import {
  EM_DASH,
  LoadError,
  ReasonList,
  SectionHeading,
  dateTime,
  labelize,
  num,
  useResource,
} from "./siteShared";

interface MapPoint {
  id: string;
  layer: string;
  label: string;
  lat: number;
  lon: number;
  status?: string | null;
  severity?: string | null;
  detail?: string | null;
}

interface MapShape {
  id: string;
  layer: string;
  label: string;
  kind: "ring" | "circle" | "line";
  ring?: Array<[number, number]>;
  centreLat?: number | null;
  centreLon?: number | null;
  radiusM?: number | null;
  status?: string | null;
  severity?: string | null;
}

interface MapResponse {
  asOf: string;
  projectName: string | null;
  bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  points: MapPoint[];
  shapes: MapShape[];
  byLayer: Record<string, number>;
  gateWindowFrom: string;
  reasons: string[];
}

const LAYERS: Array<{ key: string; label: string; colour: string }> = [
  { key: "zone", label: "Exclusion zones", colour: "var(--color-danger-fg, #dc2626)" },
  { key: "utility", label: "Buried services", colour: "#a16207" },
  { key: "survey", label: "Survey control", colour: "#0f766e" },
  { key: "geotech", label: "Boreholes", colour: "#7c3aed" },
  { key: "strike", label: "Strikes", colour: "#b91c1c" },
  { key: "gate", label: "Gate reads", colour: "#2563eb" },
  { key: "environment", label: "Environmental events", colour: "#c2410c" },
  { key: "project", label: "Project centre", colour: "#334155" },
];

const WIDTH = 900;
const HEIGHT = 520;
const EARTH_RADIUS_M = 6_371_008.8;

export default function PlanTab({ projectId }: { projectId: string }) {
  const plan = useResource<MapResponse>(`/api/v1/projects/${projectId}/site/map`);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<MapPoint | null>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const d = plan.data;

  const projection = useMemo(() => {
    if (!d?.bounds) return null;
    const { minLat, maxLat, minLon, maxLon } = d.bounds;
    const padLat = Math.max((maxLat - minLat) * 0.12, 0.00015);
    const padLon = Math.max((maxLon - minLon) * 0.12, 0.00015);
    const lat0 = minLat - padLat;
    const lat1 = maxLat + padLat;
    const lon0 = minLon - padLon;
    const lon1 = maxLon + padLon;
    const midLat = (lat0 + lat1) / 2;
    const cos = Math.cos((midLat * Math.PI) / 180);
    // Equirectangular: scale longitude by cos(latitude) so the plan is not
    // stretched east–west. One projection for points and shapes alike.
    const spanX = (lon1 - lon0) * cos;
    const spanY = lat1 - lat0;
    const scale = Math.min(WIDTH / (spanX || 1e-9), HEIGHT / (spanY || 1e-9));
    const offsetX = (WIDTH - spanX * scale) / 2;
    const offsetY = (HEIGHT - spanY * scale) / 2;
    return {
      x: (lon: number) => offsetX + (lon - lon0) * cos * scale,
      y: (lat: number) => HEIGHT - offsetY - (lat - lat0) * scale,
      metresToPx: (m: number) => (m / EARTH_RADIUS_M) * (180 / Math.PI) * scale,
      scale,
    };
  }, [d?.bounds]);

  function toggle(layer: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  }

  const visiblePoints = (d?.points ?? []).filter((p) => !hidden.has(p.layer) && p.layer !== "zone_label");
  const visibleShapes = (d?.shapes ?? []).filter((s) => !hidden.has(s.layer));

  return (
    <div className="space-y-3">
      {plan.error ? <LoadError message={plan.error} onRetry={plan.reload} title="The site plan could not be loaded" /> : null}
      <Card>
        <CardBody>
          <SectionHeading
            title="Site plan"
            hint={
              d
                ? `Drawn from this project's own records — no external map tiles. Gate reads shown from ${dateTime(d.gateWindowFrom)}. As at ${dateTime(d.asOf)}.`
                : "Reading the site's records…"
            }
            actions={
              <span className="flex items-center gap-1">
                <Button size="xs" variant="ghost" iconOnly icon={IconZoomOut} aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.4))} />
                <span className="w-12 text-center text-2xs tabular-nums text-content-muted">{num(zoom * 100)}%</span>
                <Button size="xs" variant="ghost" iconOnly icon={IconZoomIn} aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(12, z * 1.4))} />
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  Reset
                </Button>
              </span>
            }
          />

          <div className="flex flex-wrap gap-1.5 pb-3">
            {LAYERS.filter((l) => (d?.byLayer[l.key] ?? 0) > 0).map((layer) => (
              <button
                key={layer.key}
                type="button"
                onClick={() => toggle(layer.key)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-2xs ${
                  hidden.has(layer.key) ? "border-border-subtle text-content-disabled" : "border-border text-content"
                }`}
              >
                <span aria-hidden className="size-2 rounded-full" style={{ background: layer.colour }} />
                {layer.label}
                <span className="tabular-nums text-content-muted">{d?.byLayer[layer.key] ?? 0}</span>
              </button>
            ))}
          </div>

          {d && d.bounds === null && !plan.loading ? (
            <EmptyState
              icon={IconLocation}
              title="Nothing on this site has a position yet"
              description="The plan draws this project's own records — exclusion zones, survey control, boreholes, buried service routes, strikes and located gate reads. Give one of them coordinates and it appears here. There are no external map tiles, by design."
            />
          ) : (
            <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-sunken">
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className="w-full cursor-grab touch-none select-none active:cursor-grabbing"
                style={{ maxHeight: 560 }}
                role="img"
                aria-label="Site plan"
                onPointerDown={(e) => {
                  drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  setPan({ x: drag.current.panX + (e.clientX - drag.current.x), y: drag.current.panY + (e.clientY - drag.current.y) });
                }}
                onPointerUp={(e) => {
                  drag.current = null;
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }}
              >
                <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                  {projection
                    ? visibleShapes.map((shape) => {
                        if (shape.kind === "circle" && typeof shape.centreLat === "number" && typeof shape.centreLon === "number") {
                          return (
                            <circle
                              key={shape.id}
                              cx={projection.x(shape.centreLon)}
                              cy={projection.y(shape.centreLat)}
                              r={Math.max(3, projection.metresToPx(shape.radiusM ?? 0))}
                              fill={shape.status === "active" ? "rgba(220,38,38,0.16)" : "rgba(100,116,139,0.12)"}
                              stroke={shape.status === "active" ? "#dc2626" : "#64748b"}
                              strokeWidth={1.5 / zoom}
                              strokeDasharray={shape.status === "active" ? undefined : `${4 / zoom} ${3 / zoom}`}
                            >
                              <title>{`${shape.label} — ${labelize(shape.status)}`}</title>
                            </circle>
                          );
                        }
                        const pts = (shape.ring ?? []).map(([lon, lat]) => `${projection.x(lon)},${projection.y(lat)}`).join(" ");
                        if (!pts) return null;
                        if (shape.kind === "line") {
                          return (
                            <polyline
                              key={shape.id}
                              points={pts}
                              fill="none"
                              stroke="#a16207"
                              strokeWidth={2.5 / zoom}
                              strokeDasharray={shape.severity === "verified" ? undefined : `${6 / zoom} ${4 / zoom}`}
                            >
                              <title>{`${shape.label} — ${labelize(shape.severity)} confidence`}</title>
                            </polyline>
                          );
                        }
                        return (
                          <polygon
                            key={shape.id}
                            points={pts}
                            fill={shape.status === "active" ? "rgba(220,38,38,0.16)" : "rgba(100,116,139,0.12)"}
                            stroke={shape.status === "active" ? "#dc2626" : "#64748b"}
                            strokeWidth={1.5 / zoom}
                          >
                            <title>{`${shape.label} — ${labelize(shape.status)}`}</title>
                          </polygon>
                        );
                      })
                    : null}

                  {projection
                    ? visiblePoints.map((point) => {
                        const colour = LAYERS.find((l) => l.key === point.layer)?.colour ?? "#334155";
                        return (
                          <g key={point.id} onClick={() => setSelected(point)} style={{ cursor: "pointer" }}>
                            <circle
                              cx={projection.x(point.lon)}
                              cy={projection.y(point.lat)}
                              r={(point.layer === "strike" ? 6 : 4) / Math.sqrt(zoom)}
                              fill={colour}
                              stroke="var(--color-surface, #fff)"
                              strokeWidth={1 / zoom}
                            >
                              <title>{`${point.label}${point.detail ? ` — ${point.detail}` : ""}`}</title>
                            </circle>
                          </g>
                        );
                      })
                    : null}
                </g>
              </svg>
            </div>
          )}

          <ReasonList reasons={d?.reasons ?? []} className="mt-3" />
        </CardBody>
      </Card>

      {selected ? (
        <Card>
          <CardBody>
            <SectionHeading
              title={selected.label}
              hint={`${labelize(selected.layer)} · ${selected.lat.toFixed(6)}, ${selected.lon.toFixed(6)}`}
              actions={
                <Button size="xs" variant="ghost" onClick={() => setSelected(null)}>
                  Close
                </Button>
              }
            />
            <div className="flex flex-wrap gap-2 text-meta">
              {selected.status ? <Badge tone="neutral" size="xs">{labelize(selected.status)}</Badge> : null}
              {selected.severity ? <Badge tone="warning" size="xs">{labelize(selected.severity)}</Badge> : null}
              <span className="text-content-muted">{selected.detail ?? EM_DASH}</span>
            </div>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
