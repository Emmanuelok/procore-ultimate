/**
 * Accommodation and welfare inspection scoring (#683-688): scored areas,
 * occupancy-density compliance (#684) and dated corrective actions. A score
 * of 2 or less is a failure, not a low average — it is named as such.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WELFARE_INSPECTION_AREAS } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate } from "../format";
import {
  AXIS_INK,
  BRAND,
  GRID,
  LoadError,
  RED,
  fmtNum,
  isoToday,
  label,
  type ListResponse,
  type VendorRow,
  type WelfareRow,
} from "./workforceShared";

interface AreaDraft {
  area: string;
  score: number;
  note: string;
}

interface ActionDraft {
  text: string;
  dueDate: string;
}

export default function WelfareTab({
  projectId,
  vendors,
  onMutate,
}: {
  projectId: string;
  vendors: VendorRow[];
  onMutate: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [rows, setRows] = useState<WelfareRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WelfareRow | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<WelfareRow>>(
        `${base}/welfare-inspections?pageSize=100`,
      );
      setRows(res.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load welfare inspections");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailError(null);
      setDetail(null);
      try {
        setDetail(await api.get<WelfareRow>(`${base}/welfare-inspections/${id}`));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load the inspection");
      }
    },
    [base],
  );

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  /* ------------------------------ create modal ----------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [date, setDate] = useState(isoToday());
  const [location, setLocation] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [occupancy, setOccupancy] = useState("");
  const [capacity, setCapacity] = useState("");
  const [areas, setAreas] = useState<AreaDraft[]>([]);
  const [actions, setActions] = useState<ActionDraft[]>([]);

  /** The list endpoint returns vendorId only — the employer name is joined here. */
  const vendorName = useCallback(
    (id: string | null): string | null => (id ? (vendors.find((v) => v.id === id)?.name ?? id) : null),
    [vendors],
  );

  function openCreate() {
    setCreateError(null);
    setDate(isoToday());
    setLocation("");
    setVendorId("");
    setOccupancy("");
    setCapacity("");
    setAreas(
      WELFARE_INSPECTION_AREAS.slice(0, 4).map((a) => ({ area: a, score: 4, note: "" })),
    );
    setActions([]);
    setCreateOpen(true);
  }

  function toggleArea(area: string) {
    setAreas((prev) =>
      prev.some((a) => a.area === area)
        ? prev.filter((a) => a.area !== area)
        : [...prev, { area, score: 4, note: "" }],
    );
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (areas.length === 0) {
      setCreateError("Score at least one welfare area — an inspection with no areas says nothing.");
      return;
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        inspectionDate: date,
        location: location.trim(),
        areas: areas.map((a) => ({
          area: a.area,
          score: a.score,
          note: a.note.trim() || null,
        })),
      };
      if (vendorId) payload["vendorId"] = vendorId;
      if (occupancy !== "") payload["occupancyCount"] = Number(occupancy);
      if (capacity !== "") payload["capacity"] = Number(capacity);
      const filled = actions.filter((a) => a.text.trim());
      if (filled.length > 0) {
        payload["actions"] = filled.map((a) => ({
          text: a.text.trim(),
          ...(a.dueDate ? { dueDate: a.dueDate } : {}),
        }));
      }
      await api.post(`${base}/welfare-inspections`, payload);
      setCreateOpen(false);
      await load();
      onMutate();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to record the inspection.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function closeAction(actionId: string) {
    if (!openId) return;
    setBusy(true);
    setDetailError(null);
    try {
      await api.post(`${base}/welfare-inspections/${openId}/actions/${actionId}/close`, {
        note: "Verified closed on re-inspection",
      });
      await loadDetail(openId);
      await load();
      onMutate();
    } catch (err) {
      setDetailError(
        err instanceof ApiClientError ? err.message : "Failed to close the corrective action.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- render -------------------------------- */

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Accommodation, sanitation, water, catering, transport and heat-stress scoring with
          occupancy-density compliance.
        </p>
        <Button onClick={openCreate}>Record inspection</Button>
      </div>

      <ErrorAlert message={error} />

      {rows !== null && rows.length === 0 && error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Spinner label="Loading welfare inspections…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No welfare inspections recorded"
          hint="Score the camps and welfare facilities. Occupancy above declared capacity and any area at 2 or below raise a signal automatically."
          action={<Button onClick={openCreate}>Record the first inspection</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Location</Th>
              <Th>Employer</Th>
              <Th className="text-right">Overall</Th>
              <Th className="text-right">Occupancy</Th>
              <Th className="text-right">Failing areas</Th>
              <Th className="text-right">Open actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-ink-50" onClick={() => setOpenId(r.id)}>
                <Td className="tabular-nums text-ink-600">{formatDate(r.inspectionDate)}</Td>
                <Td className="font-medium text-ink-900">{r.location}</Td>
                <Td className="text-ink-600">{r.vendorName ?? vendorName(r.vendorId) ?? "—"}</Td>
                <Td className="text-right tabular-nums">
                  <span
                    title={
                      r.failingAreas > 0
                        ? `${r.failingAreas} area(s) scored 2 or below — the standard is failed, not merely low`
                        : "Every area inspected scored above the failure threshold"
                    }
                  >
                    <Badge
                      tone={
                        (r.overallScore ?? 5) <= 2.5
                          ? "red"
                          : (r.overallScore ?? 5) < 3.5
                            ? "amber"
                            : "green"
                      }
                    >
                      {fmtNum(r.overallScore, 1)} / 5
                    </Badge>
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  {r.occupancyCount === null || r.capacity === null ? (
                    <span className="text-ink-300">—</span>
                  ) : (
                    <span className={r.overcrowded ? "font-semibold text-red-700" : "text-ink-700"}>
                      {r.occupancyCount} / {r.capacity}
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {r.failingAreas > 0 ? (
                    <span className="font-semibold text-red-700">{r.failingAreas}</span>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {r.openActions > 0 ? (
                    <Badge tone="amber">{r.openActions}</Badge>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------ create modal ----------------------------- */}
      <Modal
        open={createOpen}
        title="Record welfare inspection"
        onClose={() => setCreateOpen(false)}
        wide
      >
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Inspection date">
              <Input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Location">
              <Input
                required
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Camp 2 / Block C"
              />
            </Field>
            <Field label="Occupancy" hint="Heads counted.">
              <Input
                type="number"
                min="0"
                value={occupancy}
                onChange={(e) => setOccupancy(e.target.value)}
              />
            </Field>
            <Field label="Capacity" hint="Declared beds (#684).">
              <Input
                type="number"
                min="0"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Employer (vendor)">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">Not attributed</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium text-ink-600">Areas inspected</span>
              {WELFARE_INSPECTION_AREAS.map((a) => {
                const on = areas.some((x) => x.area === a);
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => toggleArea(a)}
                    className={
                      on
                        ? "rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white"
                        : "rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-600 hover:bg-ink-200"
                    }
                  >
                    {label(a)}
                  </button>
                );
              })}
            </div>
            {areas.length === 0 ? (
              <p className="rounded-md border border-dashed border-ink-200 px-3 py-2.5 text-center text-xs text-ink-400">
                Choose the areas this inspection covered.
              </p>
            ) : (
              <div className="space-y-2">
                {areas.map((a, i) => (
                  <div key={a.area} className="flex flex-wrap items-center gap-2">
                    <span className="w-32 text-xs font-medium text-ink-700">{label(a.area)}</span>
                    <span className="flex gap-1">
                      {[1, 2, 3, 4, 5].map((s) => (
                        <button
                          key={s}
                          type="button"
                          aria-label={`${label(a.area)} score ${s}`}
                          onClick={() =>
                            setAreas((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, score: s } : x)),
                            )
                          }
                          className={
                            a.score === s
                              ? s <= 2
                                ? "h-7 w-7 rounded bg-red-600 text-xs font-semibold text-white"
                                : "h-7 w-7 rounded bg-brand-600 text-xs font-semibold text-white"
                              : "h-7 w-7 rounded bg-ink-100 text-xs font-medium text-ink-600 hover:bg-ink-200"
                          }
                        >
                          {s}
                        </button>
                      ))}
                    </span>
                    <Input
                      className="min-w-40 flex-1"
                      value={a.note}
                      onChange={(e) =>
                        setAreas((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)),
                        )
                      }
                      placeholder="What was seen"
                    />
                  </div>
                ))}
                <p className="text-xs text-ink-400">
                  A score of 2 or less fails the standard and raises a signal.
                </p>
              </div>
            )}
          </div>

          <div className="rounded-md bg-ink-50 px-3 py-2.5">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs font-medium text-ink-600">Corrective actions</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setActions((prev) => [...prev, { text: "", dueDate: "" }])}
              >
                Add action
              </Button>
            </div>
            {actions.length === 0 ? (
              <p className="text-xs text-ink-400">
                A failing area with no dated action is a finding nobody owns — add one for every
                area scored 2 or below.
              </p>
            ) : (
              <div className="space-y-2">
                {actions.map((a, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      className="min-w-48 flex-1"
                      value={a.text}
                      onChange={(e) =>
                        setActions((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                        )
                      }
                      placeholder="Install six additional toilets in Block C"
                    />
                    <Input
                      type="date"
                      className="w-40"
                      title="Due date"
                      value={a.dueDate}
                      onChange={(e) =>
                        setActions((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove corrective action ${i + 1}`}
                      onClick={() => setActions((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record inspection"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* ------------------------------ detail modal ----------------------------- */}
      <Modal
        open={openId !== null}
        title={detail ? `${detail.location} — ${formatDate(detail.inspectionDate)}` : "Inspection"}
        onClose={() => {
          setOpenId(null);
          setDetail(null);
        }}
        wide
      >
        <ErrorAlert message={detailError} />
        {detail === null ? (
          <Spinner />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={(detail.overallScore ?? 5) <= 2.5 ? "red" : "green"}>
                Overall {fmtNum(detail.overallScore, 1)} / 5
              </Badge>
              {detail.overcrowded ? (
                <Badge tone="red">
                  Overcrowded — {detail.occupancyCount} in {detail.capacity} beds
                </Badge>
              ) : detail.occupancyCount !== null && detail.capacity !== null ? (
                <Badge tone="green">
                  Occupancy {detail.occupancyCount} / {detail.capacity}
                </Badge>
              ) : null}
              {detail.vendorName ? (
                <span className="text-xs text-ink-500">Employer: {detail.vendorName}</span>
              ) : null}
            </div>

            <AreaScoreChart areas={detail.areas} />

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Corrective actions
              </h3>
              {detail.actions.length === 0 ? (
                <p className="rounded-md border border-dashed border-ink-200 px-3 py-2 text-xs text-ink-400">
                  No corrective actions were raised from this inspection.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.actions.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center gap-2 rounded-md bg-white px-3 py-2 text-xs ring-1 ring-ink-100"
                    >
                      <span className={a.closed ? "text-ink-400 line-through" : "text-ink-800"}>
                        {a.text}
                      </span>
                      {a.dueDate ? (
                        <span className="text-ink-400">due {formatDate(a.dueDate)}</span>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2">
                        {a.closed ? (
                          <Badge tone="green">Closed</Badge>
                        ) : (
                          <Button size="sm" disabled={busy} onClick={() => void closeAction(a.id)}>
                            Close
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Scored areas, 1-5, failing areas (≤2) in red. */
function AreaScoreChart({ areas }: { areas: { area: string; score: number; note: string | null }[] }) {
  if (areas.length === 0) return null;
  const ROW_H = 24;
  const BAR_H = 12;
  const PAD = { top: 6, right: 30, bottom: 20, left: 118 };
  const W = 620;
  const plotW = W - PAD.left - PAD.right;
  const H = PAD.top + areas.length * ROW_H + PAD.bottom;
  const x = (score: number) => PAD.left + (score / 5) * plotW;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Welfare area scores out of five"
      >
        {[0, 1, 2, 3, 4, 5].map((t) => (
          <g key={t}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke={t === 2 ? RED : GRID}
              strokeWidth={1}
              strokeDasharray={t === 2 ? "3 3" : undefined}
              opacity={t === 2 ? 0.5 : 1}
            />
            <text
              x={x(t)}
              y={H - PAD.bottom + 13}
              textAnchor="middle"
              fontSize={9}
              fill={t === 2 ? RED : AXIS_INK}
              className="tabular-nums"
            >
              {t}
            </text>
          </g>
        ))}
        {areas.map((a, i) => {
          const top = PAD.top + i * ROW_H + (ROW_H - BAR_H) / 2;
          const failing = a.score <= 2;
          return (
            <g key={a.area}>
              <text
                x={PAD.left - 8}
                y={top + BAR_H - 2}
                textAnchor="end"
                fontSize={10}
                fill={failing ? RED : AXIS_INK}
                fontWeight={failing ? 600 : 400}
              >
                {label(a.area)}
              </text>
              <rect
                x={PAD.left}
                y={top}
                width={Math.max(x(a.score) - PAD.left, 2)}
                height={BAR_H}
                fill={failing ? RED : BRAND}
                rx={1.5}
              >
                <title>
                  {`${label(a.area)}: ${a.score} of 5${failing ? " — FAILS the standard" : ""}${
                    a.note ? ` · ${a.note}` : ""
                  }`}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-[11px] text-ink-400">
        The dashed line at 2 is the failure threshold — anything at or below it raises a signal.
      </p>
    </div>
  );
}
