/**
 * Site waste register — spec Vol II Domain I (#513-514).
 *
 * Diversion from landfill is the headline because it is the number that
 * appears in planning conditions, BREEAM credits and contract KPIs. The
 * stacked bar underneath it says WHERE each stream actually went, which is
 * the question a diversion percentage on its own always invites.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { WASTE_DESTINATIONS, WASTE_STREAMS } from "@constructos/shared";
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
import { formatDate, humanize } from "../format";
import {
  CHART,
  DESTINATION_FILL,
  Legend,
  Meter,
  StatCard,
  destinationTone,
  fmtNum,
  fmtPct,
  streamTone,
  type ListResponse,
  type WasteRow,
  type WasteSummary,
} from "./esgShared";

const DIVERSION_TOOLTIP =
  "Everything that did not go to landfill, as a share of total tonnage moved. Reuse, recycling " +
  "and recovery all count as diverted. Energy-from-waste should be booked as recovered, not " +
  "incinerated, so the two are reported separately rather than assumed.";

const CONSIGNMENT_HINT =
  "Duty-of-care reference: the waste transfer note or, for hazardous waste, the consignment " +
  "note number. Without it the movement cannot be evidenced to a regulator.";

function diversionTone(pct: number): "green" | "amber" | "red" {
  if (pct >= 90) return "green";
  if (pct >= 70) return "amber";
  return "red";
}

/* --------------------------- stacked bar chart --------------------------- */

function StreamStack({
  rows,
  truncated,
}: {
  rows: { stream: string; total: number; byDestination: Record<string, number> }[];
  truncated: boolean;
}) {
  const max = Math.max(...rows.map((r) => r.total), 0);
  if (max <= 0) return null;

  return (
    <div>
      <div className="space-y-2">
        {rows.map((r) => {
          let acc = 0;
          return (
            <div key={r.stream} className="flex items-center gap-3">
              <div className="w-28 shrink-0 truncate text-xs text-ink-600" title={humanize(r.stream)}>
                {humanize(r.stream)}
              </div>
              <div className="min-w-0 flex-1">
                <svg
                  viewBox="0 0 100 8"
                  preserveAspectRatio="none"
                  className="h-4 w-full"
                  role="img"
                  aria-label={`${humanize(r.stream)}: ${fmtNum(r.total)} tonnes by destination`}
                >
                  <rect x={0} y={0} width={100} height={8} fill={CHART.ink100} />
                  {WASTE_DESTINATIONS.map((d) => {
                    const v = r.byDestination[d] ?? 0;
                    if (v <= 0) return null;
                    const w = (v / max) * 100;
                    const x = acc;
                    acc += w;
                    return (
                      <rect
                        key={d}
                        x={x}
                        y={0}
                        width={w}
                        height={8}
                        fill={DESTINATION_FILL[d] ?? CHART.ink300}
                      >
                        <title>{`${humanize(r.stream)} → ${humanize(d)}: ${fmtNum(v)} t (${fmtPct(
                          (v / r.total) * 100,
                        )} of the stream)`}</title>
                      </rect>
                    );
                  })}
                </svg>
              </div>
              <div className="w-20 shrink-0 text-right text-xs font-medium tabular-nums text-ink-800">
                {fmtNum(r.total)} t
              </div>
            </div>
          );
        })}
      </div>
      <Legend
        items={WASTE_DESTINATIONS.map((d) => ({
          color: DESTINATION_FILL[d] ?? CHART.ink300,
          label: humanize(d),
          title:
            d === "landfill"
              ? "Landfill — the only destination that does not count as diverted."
              : undefined,
        }))}
      />
      {truncated ? (
        <p className="mt-1.5 text-[11px] text-ink-400">
          Chart built from the most recent 200 movements; the headline figures above cover every
          record.
        </p>
      ) : null}
    </div>
  );
}

/* ================================== Tab =================================== */

export default function WasteTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [summary, setSummary] = useState<WasteSummary | null>(null);
  const [records, setRecords] = useState<WasteRow[] | null>(null);
  const [recordTotal, setRecordTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sum, list] = await Promise.all([
        api.get<WasteSummary>(`${base}/waste/summary`),
        api.get<ListResponse<WasteRow>>(`${base}/waste-records?pageSize=200`),
      ]);
      setSummary(sum);
      setRecords(list.items);
      setRecordTotal(list.total);
    } catch (err) {
      setRecords((p) => p ?? []);
      setError(err instanceof Error ? err.message : "Failed to load the waste register");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Stream × destination cross-tab, built from the loaded movements. */
  const stacks = useMemo(() => {
    const byStream = new Map<string, { stream: string; total: number; byDestination: Record<string, number> }>();
    for (const r of records ?? []) {
      const bucket =
        byStream.get(r.stream) ?? { stream: r.stream, total: 0, byDestination: {} };
      bucket.total += r.tonnes;
      bucket.byDestination[r.destination] = (bucket.byDestination[r.destination] ?? 0) + r.tonnes;
      byStream.set(r.stream, bucket);
    }
    return [...byStream.values()].sort((a, b) => b.total - a.total);
  }, [records]);

  /* ------------------------------ add modal ------------------------------- */

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [wDate, setWDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [wStream, setWStream] = useState<string>("inert");
  const [wDest, setWDest] = useState<string>("recycled");
  const [wTonnes, setWTonnes] = useState("");
  const [wCarrier, setWCarrier] = useState("");
  const [wNote, setWNote] = useState("");
  const [wCost, setWCost] = useState("");

  function openAdd() {
    setFormError(null);
    setWDate(new Date().toISOString().slice(0, 10));
    setWStream("inert");
    setWDest("recycled");
    setWTonnes("");
    setWCarrier("");
    setWNote("");
    setWCost("");
    setOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        recordDate: wDate,
        stream: wStream,
        destination: wDest,
        tonnes: Number(wTonnes),
      };
      if (wCarrier.trim()) payload["carrier"] = wCarrier.trim();
      if (wNote.trim()) payload["consignmentNote"] = wNote.trim();
      if (wCost.trim()) payload["cost"] = Number(wCost);
      await api.post<WasteRow>(`${base}/waste-records`, payload);
      setOpen(false);
      await load();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "Failed to record the waste movement.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (summary === null && records === null && !error) {
    return <Spinner label="Loading waste register…" />;
  }

  const diversion = summary?.diversionFromLandfillPercent ?? 0;
  const landfillTonnes = summary?.byDestination["landfill"] ?? 0;

  return (
    <div>
      <ErrorAlert message={error} />

      {/* --------------------------- diversion headline ---------------------- */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 ring-2 ring-brand-200">
          <CardBody>
            <div className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-ink-400">
              <span>Diversion from landfill</span>
              <span
                title={DIVERSION_TOOLTIP}
                aria-label={DIVERSION_TOOLTIP}
                className="cursor-help rounded-full border border-ink-200 px-1 text-[9px] leading-4 text-ink-400"
              >
                ?
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-3">
              <span
                className={`text-4xl font-bold tabular-nums ${
                  diversionTone(diversion) === "green"
                    ? "text-emerald-700"
                    : diversionTone(diversion) === "amber"
                      ? "text-amber-700"
                      : "text-red-700"
                }`}
              >
                {fmtPct(diversion)}
              </span>
              <span className="text-sm text-ink-500">
                of{" "}
                <span className="font-medium tabular-nums text-ink-700">
                  {fmtNum(summary?.totalTonnes)}
                </span>{" "}
                tonnes moved
              </span>
            </div>
            <div className="mt-2.5">
              <Meter
                percent={diversion}
                tone={diversionTone(diversion)}
                size="lg"
                title={`${fmtPct(diversion)} diverted — ${fmtNum(landfillTonnes)} t to landfill`}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                <span>
                  <span className="font-medium tabular-nums text-red-700">
                    {fmtNum(landfillTonnes)}
                  </span>{" "}
                  t to landfill
                </span>
                <span aria-hidden>·</span>
                <span>
                  {summary?.recordCount ?? 0} movement{summary?.recordCount === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
          <StatCard
            label="Total moved"
            value={<>{fmtNum(summary?.totalTonnes)} <span className="text-sm font-medium text-ink-400">t</span></>}
            hint={`${fmtNum(summary?.hazardousTonnes)} t hazardous`}
            tone={(summary?.hazardousTonnes ?? 0) > 0 ? "amber" : undefined}
          />
          <StatCard
            label="Recycled"
            value={fmtPct(summary?.recycledPercent ?? 0)}
            hint={`${fmtNum(summary?.byDestination["recycled"] ?? 0)} t recycled`}
            title="The narrow measure: material sent for recycling alone, excluding reuse and recovery. Diversion counts all three, so this is always the smaller number and the harder one to move."
          />
          <StatCard
            label="Disposal cost"
            value={fmtNum(summary?.costTotal, 0)}
            hint="recorded against movements"
            title="Sum of the cost recorded on each movement. Waste cost is the cheapest argument for designing waste out — it is a real, invoiced number."
          />
        </div>
      </div>

      {/* ----------------------------- stream stack -------------------------- */}
      {stacks.length > 0 ? (
        <Card className="mb-5">
          <CardBody>
            <h3 className="mb-1 text-sm font-semibold text-ink-900">
              Where each stream went
            </h3>
            <p className="mb-3 text-xs text-ink-400">
              Tonnage by stream, split by destination. Bars are scaled against the largest stream.
            </p>
            <StreamStack rows={stacks} truncated={recordTotal > (records?.length ?? 0)} />
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------- records ------------------------------ */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Waste movements{" "}
          <span className="font-normal text-ink-400">
            — {recordTotal} record{recordTotal === 1 ? "" : "s"}
          </span>
        </h3>
        <Button size="sm" onClick={openAdd}>
          Record movement
        </Button>
      </div>

      {records === null ? (
        <Spinner label="Loading movements…" />
      ) : records.length === 0 ? (
        <EmptyState
          title="No waste movements recorded"
          hint="Each skip, grab or consignment leaving site is a movement: stream, destination, tonnage and the duty-of-care reference that evidences it. Diversion from landfill is computed from these, not asserted."
          action={<Button onClick={openAdd}>Record the first movement</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Stream</Th>
              <Th>Destination</Th>
              <Th className="text-right">Tonnes</Th>
              <Th>Carrier</Th>
              <Th>Duty-of-care ref</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {records.map((r) => (
              <tr key={r.id} className="hover:bg-ink-50/60">
                <Td className="whitespace-nowrap text-xs text-ink-500">{formatDate(r.recordDate)}</Td>
                <Td>
                  <Badge tone={streamTone(r.stream)}>{humanize(r.stream)}</Badge>
                </Td>
                <Td>
                  <Badge tone={destinationTone(r.destination)}>{humanize(r.destination)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-right font-medium tabular-nums text-ink-900">
                  {fmtNum(r.tonnes, 3)}
                </Td>
                <Td className="text-xs text-ink-600">{r.carrier ?? "—"}</Td>
                <Td className="font-mono text-xs text-ink-600">
                  {r.consignmentNote ?? (
                    <span
                      className="font-sans text-amber-700"
                      title="No waste transfer or consignment note recorded — this movement cannot be evidenced to a regulator."
                    >
                      not recorded
                    </span>
                  )}
                </Td>
                <Td className="whitespace-nowrap text-right tabular-nums text-ink-700">
                  {r.cost != null ? fmtNum(r.cost, 2) : "—"}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* ------------------------------- add modal ---------------------------- */}
      <Modal open={open} title="Record a waste movement" onClose={() => setOpen(false)}>
        <ErrorAlert message={formError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Date">
              <Input type="date" required value={wDate} onChange={(e) => setWDate(e.target.value)} />
            </Field>
            <Field label="Stream">
              <Select value={wStream} onChange={(e) => setWStream(e.target.value)}>
                {WASTE_STREAMS.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tonnes">
              <Input
                type="number"
                min="0.001"
                step="any"
                required
                value={wTonnes}
                onChange={(e) => setWTonnes(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Destination"
            hint="Energy-from-waste is 'recovered', not 'incinerated' — only landfill counts against diversion."
          >
            <Select value={wDest} onChange={(e) => setWDest(e.target.value)}>
              {WASTE_DESTINATIONS.map((d) => (
                <option key={d} value={d}>
                  {humanize(d)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Carrier" hint="The registered waste carrier that removed it.">
            <Input
              value={wCarrier}
              onChange={(e) => setWCarrier(e.target.value)}
              placeholder="Registered carrier name / licence"
            />
          </Field>

          <Field label="Duty-of-care reference" hint={CONSIGNMENT_HINT}>
            <Input
              value={wNote}
              onChange={(e) => setWNote(e.target.value)}
              placeholder="WTN / consignment note number"
              className="font-mono"
            />
          </Field>

          <Field label="Cost">
            <Input
              type="number"
              min="0"
              step="any"
              value={wCost}
              onChange={(e) => setWCost(e.target.value)}
              placeholder="Disposal cost for this movement"
            />
          </Field>

          {wStream === "hazardous" && !wNote.trim() ? (
            <p className="text-xs font-medium text-amber-700">
              Hazardous waste requires a consignment note. Record its reference before the movement
              is relied on as evidence.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record movement"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
