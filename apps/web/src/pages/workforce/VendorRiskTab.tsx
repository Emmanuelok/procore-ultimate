/**
 * Modern-slavery indicator scoring at subcontractor level (#694). The bar is
 * the composite score BROKEN INTO ITS COMPONENTS, so nobody has to take the
 * number on trust: flags, reconciliation findings, contract coverage and
 * identity verification are each visible in the same 100-point bar.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import {
  AXIS_INK,
  BRAND,
  BRAND_MID,
  BRAND_PALE,
  BRAND_SOFT,
  GRID,
  LoadError,
  MARK_INK,
  RED,
  bandTone,
  fmtPct,
  label,
  type VendorRiskResponse,
  type VendorRiskRow,
} from "./workforceShared";

const SEGMENTS = [
  { key: "flags", fill: BRAND, name: "Open risk flags", max: 45 },
  { key: "reconciliation", fill: BRAND_MID, name: "Ghost / overclaim signals", max: 25 },
  { key: "contracts", fill: BRAND_SOFT, name: "Contract-issuance gap", max: 18 },
  { key: "identity", fill: BRAND_PALE, name: "Identity-verification gap", max: 12 },
] as const;

const BANDS = [
  { at: 20, name: "medium" },
  { at: 45, name: "high" },
  { at: 70, name: "critical" },
];

export default function VendorRiskTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;
  const [data, setData] = useState<VendorRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<VendorRiskResponse>(`${base}/workforce/vendor-risk`));
    } catch (err) {
      setData({ items: [], total: 0, weighting: "" });
      setError(err instanceof Error ? err.message : "Failed to load subcontractor risk");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) return <Spinner label="Scoring subcontractor exposure…" />;

  if (data.items.length === 0 && error) {
    return <LoadError message={error} onRetry={() => void load()} />;
  }

  if (data.items.length === 0) {
    return (
      <EmptyState
        title="No labour on the register yet"
        hint="Subcontractor exposure is scored from the workers enrolled against each employer. Add workers to the register to start scoring."
      />
    );
  }

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.items.map((v) => (
          <VendorCard key={v.vendorId ?? "unassigned"} vendor={v} />
        ))}
      </div>

      <Card className="mb-4">
        <CardBody>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">
            How each score was reached, worst first
          </h3>
          <RiskChart rows={data.items} />
          <p className="mt-3 border-t border-ink-100 pt-2 text-xs leading-relaxed text-ink-500">
            {data.weighting}
          </p>
        </CardBody>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Employer</Th>
            <Th className="text-right">Workers</Th>
            <Th className="text-right">Contracts</Th>
            <Th className="text-right">ID verified</Th>
            <Th className="text-right">Open flags</Th>
            <Th>Indicators</Th>
            <Th className="text-right">Ghost / overclaim</Th>
            <Th className="text-right">Score</Th>
            <Th>Band</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {data.items.map((v) => {
            const indicators = Object.entries(v.flagsByIndicator);
            return (
              <tr key={v.vendorId ?? "unassigned"}>
                <Td className="font-medium text-ink-900">
                  {v.vendorName}
                  {v.vendorId === null ? (
                    <span
                      className="ml-1.5 text-xs font-normal text-amber-700"
                      title="Workers with no employer recorded — unattributed labour is itself a finding"
                    >
                      unattributed
                    </span>
                  ) : null}
                </Td>
                <Td className="text-right tabular-nums">{v.workers}</Td>
                <Td className="text-right tabular-nums">
                  <span className={v.contractIssuedPct < 1 ? "text-amber-700" : "text-ink-700"}>
                    {fmtPct(v.contractIssuedPct)}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  <span className={v.idVerifiedPct < 1 ? "text-amber-700" : "text-ink-700"}>
                    {fmtPct(v.idVerifiedPct)}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  {v.openFlags > 0 ? (
                    <span className="font-semibold text-red-700">{v.openFlags}</span>
                  ) : (
                    <span className="text-ink-300">0</span>
                  )}
                </Td>
                <Td>
                  {indicators.length === 0 ? (
                    <span className="text-ink-300">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {indicators.map(([ind, n]) => (
                        <span key={ind} className="text-xs text-ink-600" title={label(ind)}>
                          {label(ind)}
                          {n > 1 ? ` ×${n}` : ""}
                        </span>
                      ))}
                    </span>
                  )}
                </Td>
                <Td className="text-right tabular-nums text-ink-700">
                  {v.ghostSignals} / {v.overclaimSignals}
                </Td>
                <Td className="text-right text-base font-bold tabular-nums">
                  <span
                    className={
                      v.band === "critical" || v.band === "high" ? "text-red-700" : "text-ink-900"
                    }
                  >
                    {v.score}
                  </span>
                </Td>
                <Td>
                  <Badge tone={bandTone(v.band)}>{label(v.band)}</Badge>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/* ------------------------------- vendor card -------------------------------- */

const BAND_COLOR: Record<string, string> = {
  low: "#059669",
  medium: "#d97706",
  high: RED,
  critical: RED,
};

/**
 * One employer's exposure at a glance: the composite score as a ring in its
 * band colour, the headcount it is responsible for, the open indicators named
 * rather than counted, and the two coverage gaps that feed the score.
 */
function VendorCard({ vendor: v }: { vendor: VendorRiskRow }) {
  const indicators = Object.entries(v.flagsByIndicator);
  const severe = v.band === "critical" || v.band === "high";
  return (
    <Card className={severe ? "ring-1 ring-red-200" : undefined}>
      <CardBody className="flex gap-4">
        <ScoreRing score={v.score} band={v.band} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-ink-900" title={v.vendorName}>
                {v.vendorName}
              </h3>
              <p className="text-xs text-ink-500">
                {v.workers} worker{v.workers === 1 ? "" : "s"}
                {v.vendorId === null ? (
                  <span
                    className="ml-1 text-amber-700"
                    title="Workers with no employer recorded — unattributed labour is itself a finding"
                  >
                    · unattributed
                  </span>
                ) : null}
              </p>
            </div>
            <Badge tone={bandTone(v.band)}>{label(v.band)}</Badge>
          </div>

          <div className="mt-2 flex flex-wrap gap-1">
            {indicators.length === 0 ? (
              <span className="text-xs text-ink-400">No open indicators</span>
            ) : (
              indicators.map(([ind, n]) => (
                <span
                  key={ind}
                  className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-100"
                  title={`${n} open ${label(ind)} indicator${n === 1 ? "" : "s"} against this employer`}
                >
                  {label(ind)}
                  {n > 1 ? ` ×${n}` : ""}
                </span>
              ))
            )}
            {v.ghostSignals > 0 ? (
              <span
                className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-100"
                title="Ghost-worker signals raised by payroll reconciliation"
              >
                Ghost ×{v.ghostSignals}
              </span>
            ) : null}
            {v.overclaimSignals > 0 ? (
              <span
                className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-amber-100"
                title="Payroll-overclaim signals raised by reconciliation"
              >
                Overclaim ×{v.overclaimSignals}
              </span>
            ) : null}
          </div>

          <div className="mt-3 space-y-1.5">
            <CoverageBar
              label="Contracts issued"
              fraction={v.contractIssuedPct}
              count={v.contractIssued}
              of={v.workers}
            />
            <CoverageBar
              label="Identity verified"
              fraction={v.idVerifiedPct}
              count={v.idVerified}
              of={v.workers}
            />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function ScoreRing({ score, band }: { score: number; band: string }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const colour = BAND_COLOR[band] ?? MARK_INK;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * C;
  return (
    <svg
      width={68}
      height={68}
      viewBox="0 0 68 68"
      role="img"
      aria-label={`Composite exposure score ${score} of 100, ${band} band`}
      className="shrink-0"
    >
      <title>{`${score} / 100 — ${label(band)} exposure`}</title>
      <circle cx={34} cy={34} r={R} fill="none" stroke={GRID} strokeWidth={7} />
      <circle
        cx={34}
        cy={34}
        r={R}
        fill="none"
        stroke={colour}
        strokeWidth={7}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${C - filled}`}
        transform="rotate(-90 34 34)"
      />
      <text
        x={34}
        y={38}
        textAnchor="middle"
        fontSize={18}
        fontWeight={700}
        fill={colour}
        className="tabular-nums"
      >
        {score}
      </text>
    </svg>
  );
}

function CoverageBar({
  label: barLabel,
  fraction,
  count,
  of,
}: {
  label: string;
  fraction: number;
  count: number;
  of: number;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  const short = pct < 100;
  return (
    <div title={`${count} of ${of} — ${pct}%`}>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-ink-500">{barLabel}</span>
        <span className={short ? "font-medium tabular-nums text-amber-700" : "tabular-nums text-ink-500"}>
          {count}/{of} · {pct}%
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div
          className={short ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-brand-600"}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------ the chart ---------------------------------- */

function RiskChart({ rows }: { rows: VendorRiskRow[] }) {
  const shown = rows.slice(0, 14);
  const ROW_H = 28;
  const BAR_H = 15;
  const PAD = { top: 18, right: 44, bottom: 24, left: 150 };
  const W = 720;
  const plotW = W - PAD.left - PAD.right;
  const H = PAD.top + shown.length * ROW_H + PAD.bottom;
  const x = (score: number) => PAD.left + (score / 100) * plotW;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[560px]"
          role="img"
          aria-label="Composite modern-slavery exposure score by subcontractor, broken into components"
        >
          {[0, 20, 40, 60, 80, 100].map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={PAD.top - 4}
                y2={H - PAD.bottom}
                stroke={GRID}
                strokeWidth={1}
              />
              <text
                x={x(t)}
                y={H - PAD.bottom + 14}
                textAnchor="middle"
                fontSize={9}
                fill={AXIS_INK}
                className="tabular-nums"
              >
                {t}
              </text>
            </g>
          ))}

          {/* band thresholds — where the score changes what must happen next */}
          {BANDS.map((b) => (
            <g key={b.name}>
              <line
                x1={x(b.at)}
                x2={x(b.at)}
                y1={PAD.top - 4}
                y2={H - PAD.bottom}
                stroke={b.name === "critical" ? RED : MARK_INK}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.55}
              >
                <title>{`${label(b.name)} band starts at ${b.at}`}</title>
              </line>
              <text
                x={x(b.at)}
                y={PAD.top - 8}
                textAnchor="middle"
                fontSize={8.5}
                fill={b.name === "critical" ? RED : AXIS_INK}
              >
                {b.name}
              </text>
            </g>
          ))}

          {shown.map((v, i) => {
            const top = PAD.top + i * ROW_H;
            let cursor = PAD.left;
            const severe = v.band === "critical" || v.band === "high";
            return (
              <g key={v.vendorId ?? "unassigned"}>
                <text
                  x={PAD.left - 8}
                  y={top + BAR_H / 2 + 4}
                  textAnchor="end"
                  fontSize={10}
                  fill={severe ? MARK_INK : AXIS_INK}
                  fontWeight={severe ? 600 : 400}
                >
                  {v.vendorName.length > 22 ? `${v.vendorName.slice(0, 21)}…` : v.vendorName}
                </text>

                {v.score === 0 ? (
                  <rect
                    x={PAD.left}
                    y={top}
                    width={2}
                    height={BAR_H}
                    fill={GRID}
                    rx={1}
                  >
                    <title>{`${v.vendorName} — no exposure scored`}</title>
                  </rect>
                ) : null}

                {SEGMENTS.map((seg) => {
                  const value = v.components[seg.key];
                  if (value <= 0) return null;
                  const w = (value / 100) * plotW;
                  const rectX = cursor;
                  cursor += w;
                  return (
                    <rect
                      key={seg.key}
                      x={rectX}
                      y={top}
                      width={Math.max(w, 1)}
                      height={BAR_H}
                      fill={seg.fill}
                    >
                      <title>{`${v.vendorName} — ${seg.name}: ${value} of ${seg.max} pts`}</title>
                    </rect>
                  );
                })}

                <text
                  x={Math.max(x(v.score) + 6, PAD.left + 6)}
                  y={top + BAR_H / 2 + 4}
                  fontSize={10}
                  fontWeight={700}
                  fill={severe ? RED : MARK_INK}
                  className="tabular-nums"
                >
                  {v.score}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-4 text-[11px] text-ink-500">
        {SEGMENTS.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: s.fill }} />
            {s.name} <span className="text-ink-400">(max {s.max})</span>
          </span>
        ))}
        {rows.length > shown.length ? (
          <span className="text-ink-400">
            showing the {shown.length} worst of {rows.length} employers
          </span>
        ) : null}
      </div>
    </div>
  );
}
