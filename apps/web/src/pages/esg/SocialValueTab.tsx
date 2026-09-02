/**
 * Social value — spec Vol II Domain I (#527-540).
 *
 * This is a reconciliation, not a report: what was promised in the tender
 * against what has actually been evidenced on the ground. The commitment is
 * a scored contractual obligation, so the shortfall — not the delivery — is
 * the number that carries consequence, and it is shown in red wherever it
 * appears.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SOCIAL_VALUE_THEMES } from "@constructos/shared";
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
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import EvidenceSelect from "./EvidenceSelect";
import {
  Drawer,
  Meter,
  StatCard,
  THEME_LABELS,
  THEME_NUMBERS,
  commitmentTone,
  fmtNum,
  fmtPct,
  fmtProxy,
  svNumber,
  type CommitmentDetail,
  type CommitmentRow,
  type DeliveryRow,
  type ListResponse,
  type SocialValueSummary,
} from "./esgShared";

const PROXY_TOOLTIP =
  "Proxy financial value: the monetised value of the social value delivered, using the proxy " +
  "rate recorded against each commitment (the TOMs framework publishes these in sterling). It " +
  "is the only figure comparable across measures — weeks, jobs and £ spend cannot be added up.";

const THEME_PROGRESS_TOOLTIP =
  "Units differ across the measures inside a theme (apprenticeship weeks, jobs, £ spend), so " +
  "this bar is a unit-weighted roll-up and is indicative only. The proxy value beneath it is " +
  "the comparable figure.";

function progressTone(percent: number, status?: string): "green" | "amber" | "red" | "brand" {
  if (status === "shortfall") return "red";
  if (status === "at_risk") return "amber";
  if (percent >= 100) return "green";
  return "brand";
}

/* ================================== Tab =================================== */

export default function SocialValueTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [summary, setSummary] = useState<SocialValueSummary | null>(null);
  const [commitments, setCommitments] = useState<CommitmentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sum, list] = await Promise.all([
        api.get<SocialValueSummary>(`${base}/social-value/summary`),
        api.get<ListResponse<CommitmentRow>>(`${base}/social-value?pageSize=100`),
      ]);
      setSummary(sum);
      setCommitments(list.items);
    } catch (err) {
      setCommitments((p) => p ?? []);
      setError(err instanceof Error ? err.message : "Failed to load social value commitments");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------- drawer -------------------------------- */

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommitmentDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetail(null);
      setDetailError(null);
      try {
        setDetail(await api.get<CommitmentDetail>(`${base}/social-value/${id}`));
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : "Failed to load the commitment");
      }
    },
    [base],
  );

  useEffect(() => {
    if (openId) void loadDetail(openId);
  }, [openId, loadDetail]);

  /* --------------------------- delivery form ------------------------------ */

  const [dDate, setDDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dValue, setDValue] = useState("");
  const [dNote, setDNote] = useState("");
  const [dEvidence, setDEvidence] = useState<string[]>([]);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);

  function resetDelivery() {
    setDDate(new Date().toISOString().slice(0, 10));
    setDValue("");
    setDNote("");
    setDEvidence([]);
    setDeliveryError(null);
  }

  async function onRecordDelivery(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setDeliveryError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        deliveryDate: dDate,
        value: Number(dValue),
      };
      if (dNote.trim()) payload["note"] = dNote.trim();
      if (dEvidence.length > 0) payload["evidenceIds"] = dEvidence;
      const res = await api.post<{ delivery: DeliveryRow; commitment: CommitmentRow }>(
        `${base}/social-value/${detail.id}/deliveries`,
        payload,
      );
      resetDelivery();
      setDetail({
        ...res.commitment,
        deliveries: [...detail.deliveries, res.delivery],
      });
      await load();
    } catch (err) {
      setDeliveryError(
        err instanceof ApiClientError ? err.message : "Failed to record the delivery.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------- create commitment -------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cTheme, setCTheme] = useState<string>("economic_inequality");
  const [cRef, setCRef] = useState("");
  const [cDesc, setCDesc] = useState("");
  const [cUnit, setCUnit] = useState("");
  const [cTarget, setCTarget] = useState("");
  const [cProxy, setCProxy] = useState("");
  const [cDue, setCDue] = useState("");

  function openCreate() {
    setCreateError(null);
    setCTheme("economic_inequality");
    setCRef("");
    setCDesc("");
    setCUnit("");
    setCTarget("");
    setCProxy("");
    setCDue("");
    setCreateOpen(true);
  }

  const proxyTotal =
    Number(cTarget) > 0 && Number(cProxy) > 0 ? Number(cTarget) * Number(cProxy) : null;

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        theme: cTheme,
        description: cDesc.trim(),
        unit: cUnit.trim(),
        targetValue: Number(cTarget),
      };
      if (cRef.trim()) payload["measureRef"] = cRef.trim();
      if (cProxy.trim()) payload["proxyValuePerUnit"] = Number(cProxy);
      if (cDue) payload["dueDate"] = cDue;
      const created = await api.post<CommitmentRow>(`${base}/social-value`, payload);
      setCreateOpen(false);
      await load();
      setOpenId(created.id);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the commitment.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (summary === null && commitments === null && !error) {
    return <Spinner label="Loading social value…" />;
  }

  const overall = summary?.overall;

  return (
    <div>
      <ErrorAlert message={error} />

      {/* ------------------------------- overall ------------------------------ */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Proxy value delivered"
          value={fmtProxy(overall?.proxyValueDelivered ?? 0)}
          hint={`of ${fmtProxy(overall?.proxyValueCommitted ?? 0)} committed at tender`}
          title={PROXY_TOOLTIP}
          tone="brand"
          emphasized
        />
        <StatCard
          label="Proxy value shortfall"
          value={fmtProxy(overall?.proxyValueShortfall ?? 0)}
          hint="promised but not yet evidenced"
          tone={(overall?.proxyValueShortfall ?? 0) > 0 ? "red" : "green"}
          title="The gap between the monetised value promised at tender and the value evidenced as delivered. On UK public work this is a contract-performance issue and a disclosable one."
        />
        <StatCard
          label="Commitments delivered"
          value={`${overall?.delivered ?? 0} / ${overall?.commitments ?? 0}`}
          hint={`${overall?.onTrack ?? 0} in progress`}
        />
        <StatCard
          label="At risk / shortfall"
          value={`${overall?.atRisk ?? 0} / ${overall?.shortfall ?? 0}`}
          hint="past due and under-delivered"
          tone={(overall?.shortfall ?? 0) > 0 ? "red" : (overall?.atRisk ?? 0) > 0 ? "amber" : undefined}
        />
      </div>

      {/* ------------------------------- themes ------------------------------- */}
      <h3 className="mb-2 text-sm font-semibold text-ink-900">
        UK Social Value Model themes{" "}
        <span className="font-normal text-ink-400">— PPN 06/20, committed vs delivered</span>
      </h3>
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {SOCIAL_VALUE_THEMES.map((t) => {
          const stats = summary?.byTheme[t];
          const pct = stats?.progressPercent ?? 0;
          const has = (stats?.commitments ?? 0) > 0;
          return (
            <Card key={t} className={has ? undefined : "opacity-60"}>
              <CardBody className="py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
                  {THEME_NUMBERS[t]}
                </div>
                <div className="mt-0.5 text-sm font-semibold leading-snug text-ink-900">
                  {THEME_LABELS[t]}
                </div>
                {has ? (
                  <>
                    <div className="mt-2 flex items-baseline justify-between text-xs">
                      <span className="tabular-nums text-ink-500">
                        {fmtNum(stats?.delivered)} / {fmtNum(stats?.committed)}
                      </span>
                      <span
                        className={`font-semibold tabular-nums ${
                          pct >= 100 ? "text-emerald-700" : "text-ink-700"
                        }`}
                      >
                        {fmtPct(pct, 0)}
                      </span>
                    </div>
                    <div title={THEME_PROGRESS_TOOLTIP}>
                      <Meter percent={pct} tone={pct >= 100 ? "green" : "brand"} />
                    </div>
                    <div className="mt-1.5 text-xs text-ink-500">
                      <span className="font-semibold tabular-nums text-brand-700">
                        {fmtProxy(stats?.proxyValueDelivered ?? 0)}
                      </span>{" "}
                      proxy value delivered
                    </div>
                    <div className="text-[11px] text-ink-400">
                      {stats?.commitments} commitment{stats?.commitments === 1 ? "" : "s"} ·{" "}
                      {fmtProxy(stats?.proxyValueCommitted ?? 0)} committed
                    </div>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-ink-400">
                    No commitments made under this theme.
                  </p>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>

      {/* ----------------------------- commitments ---------------------------- */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Tender commitments{" "}
          <span className="font-normal text-ink-400">— promised vs delivered</span>
        </h3>
        <Button size="sm" onClick={openCreate}>
          New commitment
        </Button>
      </div>

      {commitments === null ? (
        <Spinner label="Loading commitments…" />
      ) : commitments.length === 0 ? (
        <EmptyState
          title="No social value commitments recorded"
          hint="Record what the bid promised — apprenticeship weeks, local spend, volunteering hours — with its target, due date and proxy value. Delivery is then evidenced against the promise rather than reconstructed at the end of the job."
          action={<Button onClick={openCreate}>Record the first commitment</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>No.</Th>
              <Th>Theme</Th>
              <Th>Commitment</Th>
              <Th className="text-right">Target</Th>
              <Th>Delivered</Th>
              <Th>Due</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {commitments.map((c) => {
              const shortfall = c.status === "shortfall";
              return (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setOpenId(c.id)}
                >
                  <Td className="whitespace-nowrap font-mono text-xs text-ink-500">
                    {svNumber(c.number)}
                  </Td>
                  <Td>
                    <Badge tone="violet">{THEME_LABELS[c.theme] ?? humanize(c.theme)}</Badge>
                  </Td>
                  <Td>
                    <div className="max-w-sm truncate font-medium text-ink-900" title={c.description}>
                      {c.description}
                    </div>
                    {c.measureRef ? (
                      <div className="text-[11px] text-ink-400">TOMs {c.measureRef}</div>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-ink-700">
                    {fmtNum(c.targetValue)} <span className="text-xs text-ink-400">{c.unit}</span>
                  </Td>
                  <Td className="min-w-40">
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                      <span className="tabular-nums font-medium text-ink-800">
                        {fmtNum(c.deliveredValue)}
                      </span>
                      <span
                        className={`tabular-nums ${shortfall ? "font-semibold text-red-700" : "text-ink-400"}`}
                      >
                        {fmtPct(c.progressPercent, 0)}
                      </span>
                    </div>
                    <Meter
                      percent={c.progressPercent}
                      tone={progressTone(c.progressPercent, c.status)}
                      size="sm"
                      title={`${fmtNum(c.deliveredValue)} of ${fmtNum(c.targetValue)} ${c.unit} delivered`}
                    />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {c.dueDate ? formatDate(c.dueDate) : "—"}
                  </Td>
                  <Td>
                    {shortfall ? (
                      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-red-800">
                        Shortfall
                      </span>
                    ) : (
                      <Badge tone={commitmentTone(c.status)}>{humanize(c.status)}</Badge>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {/* -------------------------------- drawer ------------------------------ */}
      <Drawer
        open={openId !== null}
        title={
          detail ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-ink-500">{svNumber(detail.number)}</span>
              <span>{THEME_LABELS[detail.theme] ?? humanize(detail.theme)}</span>
            </span>
          ) : (
            "Commitment"
          )
        }
        onClose={() => {
          setOpenId(null);
          setDetail(null);
          resetDelivery();
        }}
        wide
      >
        <ErrorAlert message={detailError} />
        {detail === null ? (
          detailError ? null : (
            <Spinner label="Loading commitment…" />
          )
        ) : (
          <div className="space-y-5">
            <div>
              <p className="text-sm leading-relaxed text-ink-800">{detail.description}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-400">
                {detail.measureRef ? <span>TOMs measure {detail.measureRef}</span> : null}
                {detail.dueDate ? <span>due {formatDate(detail.dueDate)}</span> : null}
                <Badge tone={commitmentTone(detail.status)}>{humanize(detail.status)}</Badge>
              </div>
            </div>

            {/* reconciliation */}
            <div className="rounded-lg bg-ink-50 p-4 ring-1 ring-ink-100">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
                Tender promise vs delivered
              </div>
              <div className="mt-2 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <div className="text-xs text-ink-500">Promised</div>
                  <div className="font-semibold tabular-nums text-ink-900">
                    {fmtNum(detail.targetValue)}{" "}
                    <span className="text-xs font-normal text-ink-400">{detail.unit}</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-500">Evidenced</div>
                  <div className="font-semibold tabular-nums text-ink-900">
                    {fmtNum(detail.deliveredValue)}{" "}
                    <span className="text-xs font-normal text-ink-400">{detail.unit}</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-ink-500">Outstanding</div>
                  <div
                    className={`font-semibold tabular-nums ${
                      detail.remainingValue > 0 ? "text-red-700" : "text-emerald-700"
                    }`}
                  >
                    {fmtNum(detail.remainingValue)}{" "}
                    <span className="text-xs font-normal text-ink-400">{detail.unit}</span>
                  </div>
                </div>
              </div>
              <div className="mt-3">
                <Meter
                  percent={detail.progressPercent}
                  tone={progressTone(detail.progressPercent, detail.status)}
                  size="lg"
                  title={`${fmtPct(detail.progressPercent)} of the commitment evidenced`}
                />
                <div className="mt-1 text-xs tabular-nums text-ink-500">
                  {fmtPct(detail.progressPercent)} evidenced
                </div>
              </div>
              {detail.proxyValueCommitted != null ? (
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-200 pt-2.5 text-xs text-ink-600">
                  <span title={PROXY_TOOLTIP}>
                    Proxy value{" "}
                    <span className="font-semibold tabular-nums text-brand-700">
                      {fmtProxy(detail.proxyValueDelivered)}
                    </span>{" "}
                    of {fmtProxy(detail.proxyValueCommitted)}
                  </span>
                  <span className="text-ink-400">
                    at {fmtProxy(detail.proxyValuePerUnit)} per {detail.unit}
                  </span>
                </div>
              ) : null}
            </div>

            {/* shortfall callout */}
            {detail.status === "shortfall" || detail.status === "at_risk" ? (
              <div
                className={`rounded-md px-4 py-3 text-sm ring-1 ${
                  detail.status === "shortfall"
                    ? "bg-red-50 text-red-900 ring-red-200"
                    : "bg-amber-50 text-amber-900 ring-amber-200"
                }`}
              >
                <div className="font-semibold">
                  {detail.status === "shortfall"
                    ? `Shortfall of ${fmtNum(detail.remainingValue)} ${detail.unit}`
                    : `At risk — ${fmtPct(detail.progressPercent)} delivered with the due date passed`}
                </div>
                <p className="mt-1 text-xs leading-relaxed">
                  {detail.status === "shortfall"
                    ? "This commitment is more than 30 days past its due date and still under-delivered. Tender commitments are scored obligations: an unremediated shortfall is a contract-performance issue and, on UK public work, a disclosable one. Record the remediation plan against it, or agree a formal substitution with the client."
                    : "The due date has passed with delivery under 70%. It becomes a reportable shortfall 30 days after the due date unless delivery is evidenced or the commitment is formally varied."}
                  {detail.proxyValueCommitted != null ? (
                    <>
                      {" "}
                      Proxy value not yet delivered:{" "}
                      <strong className="tabular-nums">
                        {fmtProxy(
                          Math.max(
                            0,
                            (detail.proxyValueCommitted ?? 0) - (detail.proxyValueDelivered ?? 0),
                          ),
                        )}
                      </strong>
                      .
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}

            {/* deliveries */}
            <div>
              <h4 className="mb-2 text-sm font-semibold text-ink-900">
                Deliveries{" "}
                <span className="font-normal text-ink-400">({detail.deliveries.length})</span>
              </h4>
              {detail.deliveries.length === 0 ? (
                <p className="rounded-md border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-400">
                  Nothing evidenced against this commitment yet.
                </p>
              ) : (
                <ul className="divide-y divide-ink-100 rounded-md ring-1 ring-ink-100">
                  {detail.deliveries.map((d) => (
                    <li key={d.id} className="px-3 py-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold tabular-nums text-ink-900">
                          +{fmtNum(d.value)}{" "}
                          <span className="text-xs font-normal text-ink-400">{detail.unit}</span>
                        </span>
                        <span className="text-xs text-ink-500">{formatDate(d.deliveryDate)}</span>
                      </div>
                      {d.note ? (
                        <p className="mt-0.5 text-xs leading-relaxed text-ink-600">{d.note}</p>
                      ) : null}
                      <div className="mt-1 text-[11px]">
                        {d.evidenceIds.length > 0 ? (
                          <span className="text-emerald-700">
                            {d.evidenceIds.length} evidence record
                            {d.evidenceIds.length === 1 ? "" : "s"} attached
                          </span>
                        ) : (
                          <span
                            className="text-amber-700"
                            title="No evidence attached — this delivery is an assertion until it is substantiated."
                          >
                            no evidence attached
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* record a delivery */}
            <div className="rounded-lg ring-1 ring-ink-100">
              <div className="border-b border-ink-100 px-4 py-2.5 text-sm font-semibold text-ink-900">
                Record a delivery
              </div>
              <form onSubmit={onRecordDelivery} className="space-y-3 p-4">
                <ErrorAlert message={deliveryError} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Delivery date">
                    <Input
                      type="date"
                      required
                      value={dDate}
                      onChange={(e) => setDDate(e.target.value)}
                    />
                  </Field>
                  <Field label={`Value delivered (${detail.unit})`}>
                    <Input
                      type="number"
                      min="0.000001"
                      step="any"
                      required
                      value={dValue}
                      onChange={(e) => setDValue(e.target.value)}
                    />
                  </Field>
                </div>
                {Number(dValue) > 0 ? (
                  <p className="text-xs tabular-nums text-ink-500">
                    Takes delivery to {fmtNum(detail.deliveredValue + Number(dValue))} of{" "}
                    {fmtNum(detail.targetValue)} {detail.unit} —{" "}
                    {fmtPct(
                      detail.targetValue > 0
                        ? ((detail.deliveredValue + Number(dValue)) / detail.targetValue) * 100
                        : 0,
                    )}
                    .
                  </p>
                ) : null}
                <Field label="Note">
                  <Textarea
                    value={dNote}
                    onChange={(e) => setDNote(e.target.value)}
                    className="min-h-12"
                    placeholder="Two apprentices started with the groundworks subcontractor, weeks 14-26"
                  />
                </Field>
                <div>
                  <span className="mb-1 block text-xs font-medium text-ink-600">Evidence</span>
                  <EvidenceSelect
                    projectId={projectId}
                    selected={dEvidence}
                    onChange={setDEvidence}
                  />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy}>
                    {busy ? "Recording…" : "Record delivery"}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </Drawer>

      {/* ---------------------------- create modal ---------------------------- */}
      <Modal
        open={createOpen}
        title="New social value commitment"
        onClose={() => setCreateOpen(false)}
        wide
      >
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Theme" hint="UK Social Value Model theme, PPN 06/20.">
              <Select value={cTheme} onChange={(e) => setCTheme(e.target.value)}>
                {SOCIAL_VALUE_THEMES.map((t) => (
                  <option key={t} value={t}>
                    {THEME_NUMBERS[t]} — {THEME_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="TOMs measure reference" hint="Optional — e.g. NT21, RE1.">
              <Input
                value={cRef}
                onChange={(e) => setCRef(e.target.value)}
                placeholder="NT21"
                className="font-mono"
              />
            </Field>
          </div>

          <Field label="Commitment" hint="Word it as the bid worded it — this is the promise being reconciled.">
            <Textarea
              required
              value={cDesc}
              onChange={(e) => setCDesc(e.target.value)}
              className="min-h-16"
              placeholder="Provide 104 apprenticeship weeks to residents of the host borough over the contract period"
            />
          </Field>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Unit" hint="weeks, jobs, hours, £">
              <Input
                required
                value={cUnit}
                onChange={(e) => setCUnit(e.target.value)}
                placeholder="weeks"
              />
            </Field>
            <Field label="Target">
              <Input
                type="number"
                min="0.000001"
                step="any"
                required
                value={cTarget}
                onChange={(e) => setCTarget(e.target.value)}
              />
            </Field>
            <Field label="Proxy £ per unit" hint="TOMs proxy rate.">
              <Input
                type="number"
                min="0"
                step="any"
                value={cProxy}
                onChange={(e) => setCProxy(e.target.value)}
              />
            </Field>
            <Field label="Due date" hint="Drives at-risk and shortfall.">
              <Input type="date" value={cDue} onChange={(e) => setCDue(e.target.value)} />
            </Field>
          </div>

          {proxyTotal !== null ? (
            <p className="text-xs text-ink-500">
              Committed proxy value:{" "}
              <span className="font-semibold tabular-nums text-brand-700">
                {fmtProxy(proxyTotal)}
              </span>
            </p>
          ) : null}

          {!cDue ? (
            <p className="text-xs text-amber-700">
              Without a due date this commitment can never fall into at-risk or shortfall — it will
              sit as committed indefinitely.
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create commitment"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
