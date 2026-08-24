/**
 * Business case tab (spec #394-405): SOC/OBC/FBC lifecycle, the HM Treasury
 * five-case editor, options appraisal to OB-adjusted capex / NPV / BCR /
 * payback, preferred-option selection and the submit/approve/reject flow
 * with determination-independence (self-approval 403) surfaced as a banner.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
import {
  bcStageTone,
  fmtNum,
  SectionTitle,
  stageLabel,
  stageShort,
  type BcOption,
  type BusinessCaseRow,
  type ListResponse,
} from "./governanceShared";

const FIVE_CASES: { key: string; label: string; hint: string }[] = [
  { key: "strategic", label: "Strategic case", hint: "The case for change and strategic fit." },
  { key: "economic", label: "Economic case", hint: "Options appraisal and value for money." },
  { key: "commercial", label: "Commercial case", hint: "Procurement route and deal viability." },
  { key: "financial", label: "Financial case", hint: "Affordability and funding." },
  { key: "management", label: "Management case", hint: "Deliverability, governance, assurance." },
];

const STAGES: { value: string; label: string }[] = [
  { value: "strategic_outline", label: "SOC — Strategic outline case" },
  { value: "outline", label: "OBC — Outline business case" },
  { value: "full", label: "FBC — Full business case" },
];

function bcStatusTone(status: string): string {
  switch (status) {
    case "submitted":
      return "blue";
    case "approved":
      return "green";
    case "rejected":
      return "red";
    default:
      return "gray";
  }
}

function parseSeries(raw: string): number[] | null {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

export default function BusinessCasesTab({ projectId }: { projectId: string }) {
  const base = `/api/v1/projects/${projectId}`;

  const [items, setItems] = useState<BusinessCaseRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusinessCaseRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** determination-independence 403 (and other action failures) banner */
  const [actionError, setActionError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<ListResponse<BusinessCaseRow>>(
        `${base}/business-cases?pageSize=100`,
      );
      setItems(res.items);
      setSelectedId((prev) => prev ?? res.items[0]?.id ?? null);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : "Failed to load business cases");
    }
  }, [base]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async () => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    try {
      const bc = await api.get<BusinessCaseRow>(`${base}/business-cases/${selectedId}`);
      setDetail(bc);
      setCaseDrafts({ ...bc.cases });
      setCasesDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the business case");
    }
  }, [base, selectedId]);

  useEffect(() => {
    setActionError(null);
    void loadDetail();
  }, [loadDetail]);

  async function refresh() {
    await Promise.all([loadList(), loadDetail()]);
  }

  /* ------------------------------ create modal ------------------------------ */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cStage, setCStage] = useState("strategic_outline");
  const [cTitle, setCTitle] = useState("");
  const [cRate, setCRate] = useState("3.5");
  const [cYears, setCYears] = useState("10");
  const [cOb, setCOb] = useState("0");

  function openCreate() {
    setCreateError(null);
    setCStage("strategic_outline");
    setCTitle("");
    setCRate("3.5");
    setCYears("10");
    setCOb("0");
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const created = await api.post<BusinessCaseRow>(`${base}/business-cases`, {
        stage: cStage,
        title: cTitle.trim(),
        appraisal: {
          discountRatePercent: Number(cRate) || 0,
          appraisalYears: Math.max(1, Math.round(Number(cYears) || 1)),
          optimismBiasPercent: Number(cOb) || 0,
        },
      });
      setCreateOpen(false);
      setSelectedId(created.id);
      await loadList();
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError ? err.message : "Failed to create the business case.",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------- five-case editor ---------------------------- */

  const [caseDrafts, setCaseDrafts] = useState<Record<string, string>>({});
  const [casesDirty, setCasesDirty] = useState(false);

  async function saveCases() {
    if (!detail) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.patch(`${base}/business-cases/${detail.id}`, { cases: caseDrafts });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to save the narratives.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ option modal ------------------------------ */

  const [optOpen, setOptOpen] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optEditId, setOptEditId] = useState<string | null>(null);
  const [oName, setOName] = useState("");
  const [oCounterfactual, setOCounterfactual] = useState(false);
  const [oCapex, setOCapex] = useState("");
  const [oBenefits, setOBenefits] = useState("");
  const [oCosts, setOCosts] = useState("");

  function openOption(existing: BcOption | null) {
    setOptError(null);
    setOptEditId(existing?.id ?? null);
    setOName(existing?.name ?? "");
    setOCounterfactual(existing?.isCounterfactual ?? false);
    setOCapex(existing ? String(existing.capex) : "");
    setOBenefits(existing ? existing.annualBenefits.join(", ") : "");
    setOCosts(existing ? existing.annualCosts.join(", ") : "");
    setOptOpen(true);
  }

  interface OptionInput {
    id?: string;
    name: string;
    isCounterfactual: boolean;
    capex: number;
    annualBenefits: number[];
    annualCosts: number[];
  }

  async function putOptions(next: OptionInput[]) {
    if (!detail) return;
    await api.put(`${base}/business-cases/${detail.id}/options`, {
      options: next.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        isCounterfactual: o.isCounterfactual,
        capex: o.capex,
        annualBenefits: o.annualBenefits,
        annualCosts: o.annualCosts,
      })),
    });
  }

  async function onSaveOption(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setOptError(null);
    const benefits = parseSeries(oBenefits);
    const costs = parseSeries(oCosts);
    if (benefits === null || costs === null) {
      setOptError("Annual benefits and costs must be comma-separated numbers.");
      return;
    }
    const capex = Number(oCapex);
    if (!Number.isFinite(capex) || capex < 0) {
      setOptError("Capex must be a non-negative number.");
      return;
    }
    const edited: OptionInput = {
      name: oName.trim(),
      isCounterfactual: oCounterfactual,
      capex,
      annualBenefits: benefits,
      annualCosts: costs,
    };
    const kept: OptionInput[] = detail.options.map((o) =>
      o.id === optEditId ? { ...edited, id: o.id } : o,
    );
    const next = optEditId ? kept : [...kept, edited];
    setBusy(true);
    try {
      await putOptions(next);
      setOptOpen(false);
      await refresh();
    } catch (err) {
      setOptError(err instanceof Error ? err.message : "Failed to save the option.");
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveOption() {
    if (!detail || !optEditId) return;
    const next = detail.options.filter((o) => o.id !== optEditId);
    if (next.length === 0) {
      setOptError("A business case needs at least one option — edit this one instead.");
      return;
    }
    setBusy(true);
    try {
      await putOptions(next);
      setOptOpen(false);
      await refresh();
    } catch (err) {
      setOptError(err instanceof Error ? err.message : "Failed to remove the option.");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ appraisal edit ---------------------------- */

  const [apprOpen, setApprOpen] = useState(false);
  const [apprError, setApprError] = useState<string | null>(null);
  const [aRate, setARate] = useState("3.5");
  const [aYears, setAYears] = useState("10");
  const [aOb, setAOb] = useState("0");

  function openAppraisal() {
    if (!detail) return;
    setApprError(null);
    setARate(String(detail.appraisal.discountRatePercent ?? 3.5));
    setAYears(String(detail.appraisal.appraisalYears ?? 10));
    setAOb(String(detail.appraisal.optimismBiasPercent ?? 0));
    setApprOpen(true);
  }

  async function onSaveAppraisal(e: FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setApprError(null);
    setBusy(true);
    try {
      await api.patch(`${base}/business-cases/${detail.id}`, {
        appraisal: {
          discountRatePercent: Number(aRate) || 0,
          appraisalYears: Math.max(1, Math.round(Number(aYears) || 1)),
          optimismBiasPercent: Number(aOb) || 0,
        },
      });
      setApprOpen(false);
      await refresh();
    } catch (err) {
      setApprError(err instanceof Error ? err.message : "Failed to update the appraisal.");
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- actions --------------------------------- */

  async function selectPreferred(optionId: string) {
    if (!detail) return;
    setActionError(null);
    try {
      await api.post(`${base}/business-cases/${detail.id}/select-option`, { optionId });
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to select the option.");
    }
  }

  async function transition(verb: "submit" | "approve" | "reject") {
    if (!detail) return;
    setActionError(null);
    setBusy(true);
    try {
      await api.post(`${base}/business-cases/${detail.id}/${verb}`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : `Failed to ${verb} the business case.`);
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- render ---------------------------------- */

  if (items === null) return <Spinner />;

  if (items.length === 0) {
    return (
      <>
        <ErrorAlert message={error} />
        <EmptyState
          title="No business cases yet"
          hint="Start the SOC / OBC / FBC lifecycle — the five-case model with a discounted options appraisal under optimism bias."
          action={<Button onClick={openCreate}>New business case</Button>}
        />
        {renderCreateModal()}
      </>
    );
  }

  const editable = detail !== null && (detail.status === "draft" || detail.status === "submitted");
  const draft = detail?.status === "draft";
  const selectable = detail !== null && (detail.status === "draft" || detail.status === "submitted");

  return (
    <div>
      <ErrorAlert message={error} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* -------------------------------- list -------------------------------- */}
        <div className="lg:col-span-4">
          <div className="mb-2 flex items-center justify-between">
            <SectionTitle>Business cases</SectionTitle>
            <Button size="sm" variant="secondary" onClick={openCreate}>
              New
            </Button>
          </div>
          <div className="space-y-2">
            {items.map((bc) => (
              <button
                key={bc.id}
                type="button"
                onClick={() => setSelectedId(bc.id)}
                className={`block w-full rounded-lg px-3 py-2.5 text-left ring-1 transition-colors ${
                  bc.id === selectedId
                    ? "bg-brand-50 ring-brand-300"
                    : "bg-white ring-ink-100 hover:bg-ink-50"
                }`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone={bcStageTone(bc.stage)}>{stageShort(bc.stage)}</Badge>
                  <Badge tone={bcStatusTone(bc.status)}>{humanize(bc.status)}</Badge>
                </div>
                <div className="text-sm font-medium text-ink-900">{bc.title}</div>
                <div className="mt-0.5 text-xs text-ink-400">
                  {bc.options.length} option{bc.options.length === 1 ? "" : "s"} · created{" "}
                  {formatDate(bc.createdAt)}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ------------------------------- detail -------------------------------- */}
        <div className="lg:col-span-8">
          {detail === null ? (
            <Spinner />
          ) : (
            <div className="space-y-4">
              <Card>
                <CardBody>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="mb-1 flex items-center gap-2">
                        <Badge tone={bcStageTone(detail.stage)}>{stageShort(detail.stage)}</Badge>
                        <Badge tone={bcStatusTone(detail.status)}>{humanize(detail.status)}</Badge>
                      </div>
                      <h2 className="text-base font-semibold text-ink-900">{detail.title}</h2>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {stageLabel(detail.stage)} · discount rate{" "}
                        <strong className="tabular-nums">
                          {fmtNum(detail.appraisal.discountRatePercent ?? 3.5, 2)}%
                        </strong>{" "}
                        · horizon{" "}
                        <strong className="tabular-nums">
                          {fmtNum(detail.appraisal.appraisalYears ?? 1)} yrs
                        </strong>{" "}
                        · optimism bias{" "}
                        <strong className="tabular-nums">
                          +{fmtNum(detail.appraisal.optimismBiasPercent ?? 0, 1)}%
                        </strong>
                        {draft ? (
                          <button
                            type="button"
                            onClick={openAppraisal}
                            className="ml-2 text-xs font-medium text-brand-700 hover:text-brand-800"
                          >
                            Edit appraisal
                          </button>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {detail.status === "draft" ? (
                        <Button size="sm" disabled={busy} onClick={() => void transition("submit")}>
                          Submit for decision
                        </Button>
                      ) : null}
                      {detail.status === "submitted" ? (
                        <>
                          <Button
                            size="sm"
                            disabled={busy || !detail.preferredOptionId}
                            title={
                              detail.preferredOptionId
                                ? undefined
                                : "Select a preferred option before approving"
                            }
                            onClick={() => void transition("approve")}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busy}
                            onClick={() => void transition("reject")}
                          >
                            Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {actionError ? (
                    <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200">
                      {actionError}
                    </div>
                  ) : null}
                  {detail.status === "submitted" && !detail.preferredOptionId ? (
                    <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                      Approval requires a preferred option — pick one in the appraisal table below.
                    </div>
                  ) : null}
                  {detail.status === "approved" ? (
                    <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200">
                      Approved on {formatDate(detail.approvedAt)} — this business case is now
                      immutable.
                    </div>
                  ) : null}
                </CardBody>
              </Card>

              {/* -------------------------- options appraisal ------------------------- */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <SectionTitle>Options appraisal</SectionTitle>
                  {draft ? (
                    <Button size="sm" variant="secondary" onClick={() => openOption(null)}>
                      Add option
                    </Button>
                  ) : null}
                </div>
                {detail.options.length === 0 ? (
                  <EmptyState
                    title="No options yet"
                    hint="Add the long-list options, including the do-nothing counterfactual — the server computes OB-adjusted capex, NPV, BCR and payback."
                    action={
                      draft ? (
                        <Button size="sm" onClick={() => openOption(null)}>
                          Add the first option
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th className="w-10">Pref.</Th>
                        <Th>Option</Th>
                        <Th className="text-right">Capex</Th>
                        <Th className="text-right">OB-adjusted</Th>
                        <Th className="text-right">NPV</Th>
                        <Th className="text-right">BCR</Th>
                        <Th className="text-right">Payback</Th>
                        {draft ? <Th /> : null}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {detail.options.map((o) => {
                        const preferred = o.id === detail.preferredOptionId;
                        return (
                          <tr key={o.id} className={preferred ? "bg-brand-50/70" : undefined}>
                            <Td>
                              <input
                                type="radio"
                                name="preferred-option"
                                className="h-4 w-4 accent-brand-600"
                                checked={preferred}
                                disabled={!selectable}
                                onChange={() => void selectPreferred(o.id)}
                                aria-label={`Select ${o.name} as preferred`}
                              />
                            </Td>
                            <Td>
                              <span className="font-medium text-ink-900">{o.name}</span>
                              {o.isCounterfactual ? (
                                <span className="ml-2 inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                                  do nothing
                                </span>
                              ) : null}
                              {preferred ? (
                                <span className="ml-2 inline-flex items-center rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-800">
                                  preferred
                                </span>
                              ) : null}
                            </Td>
                            <Td className="text-right tabular-nums">{fmtNum(o.capex)}</Td>
                            <Td className="text-right tabular-nums">
                              {fmtNum(o.computed.capexAdjusted)}
                            </Td>
                            <Td
                              className={`text-right font-semibold tabular-nums ${
                                o.computed.npv < 0 ? "text-red-700" : "text-ink-900"
                              }`}
                            >
                              {fmtNum(o.computed.npv)}
                            </Td>
                            <Td className="text-right tabular-nums">
                              {o.computed.bcr === null ? "—" : fmtNum(o.computed.bcr, 2, 2)}
                            </Td>
                            <Td className="text-right tabular-nums">
                              {o.computed.paybackYear === null
                                ? "beyond horizon"
                                : o.computed.paybackYear === 0
                                  ? "immediate"
                                  : `year ${o.computed.paybackYear}`}
                            </Td>
                            {draft ? (
                              <Td className="text-right">
                                <button
                                  type="button"
                                  onClick={() => openOption(o)}
                                  className="text-xs font-medium text-brand-700 hover:text-brand-800"
                                >
                                  Edit
                                </button>
                              </Td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
              </div>

              {/* --------------------------- five-case editor ------------------------- */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <SectionTitle>Five-case model</SectionTitle>
                  {editable ? (
                    <Button size="sm" disabled={busy || !casesDirty} onClick={() => void saveCases()}>
                      {busy ? "Saving…" : "Save narratives"}
                    </Button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {FIVE_CASES.map((c) => (
                    <Card key={c.key} className={c.key === "management" ? "md:col-span-2" : ""}>
                      <CardBody className="p-3">
                        <div className="mb-1 text-xs font-semibold text-ink-700">{c.label}</div>
                        {editable ? (
                          <Textarea
                            value={caseDrafts[c.key] ?? ""}
                            placeholder={c.hint}
                            onChange={(e) => {
                              setCaseDrafts((prev) => ({ ...prev, [c.key]: e.target.value }));
                              setCasesDirty(true);
                            }}
                            className="min-h-20 text-xs"
                          />
                        ) : (
                          <p className="whitespace-pre-wrap text-xs leading-5 text-ink-600">
                            {detail.cases[c.key]?.trim() ? detail.cases[c.key] : "—"}
                          </p>
                        )}
                      </CardBody>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {renderCreateModal()}

      {/* ------------------------------ option modal ------------------------------ */}
      <Modal
        open={optOpen}
        title={optEditId ? "Edit option" : "Add option"}
        onClose={() => setOptOpen(false)}
        wide
      >
        <ErrorAlert message={optError} />
        <form onSubmit={onSaveOption} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Option name">
              <Input required value={oName} onChange={(e) => setOName(e.target.value)} />
            </Field>
            <Field label="Capex (year 0)">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={oCapex}
                onChange={(e) => setOCapex(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input
              type="checkbox"
              className="h-4 w-4 accent-brand-600"
              checked={oCounterfactual}
              onChange={(e) => setOCounterfactual(e.target.checked)}
            />
            Do-nothing / do-minimum counterfactual
          </label>
          <Field
            label="Annual benefits"
            hint="Comma-separated, year 1 first — padded with zeros / truncated to the appraisal horizon."
          >
            <Input
              value={oBenefits}
              onChange={(e) => setOBenefits(e.target.value)}
              placeholder="e.g. 0, 120000, 250000, 250000"
            />
          </Field>
          <Field label="Annual costs" hint="Recurring (non-capex) costs per year, year 1 first.">
            <Input
              value={oCosts}
              onChange={(e) => setOCosts(e.target.value)}
              placeholder="e.g. 15000, 15000, 15000"
            />
          </Field>
          <div className="flex items-center justify-between gap-2">
            <div>
              {optEditId ? (
                <Button variant="danger" size="sm" disabled={busy} onClick={() => void onRemoveOption()}>
                  Remove option
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setOptOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save option"}
              </Button>
            </div>
          </div>
        </form>
      </Modal>

      {/* ---------------------------- appraisal modal ----------------------------- */}
      <Modal open={apprOpen} title="Edit appraisal" onClose={() => setApprOpen(false)}>
        <ErrorAlert message={apprError} />
        <form onSubmit={onSaveAppraisal} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Discount rate %" hint="Green Book STPR default 3.5">
              <Input
                type="number"
                min="0"
                max="100"
                step="any"
                required
                value={aRate}
                onChange={(e) => setARate(e.target.value)}
              />
            </Field>
            <Field label="Appraisal years">
              <Input
                type="number"
                min="1"
                max="60"
                step="1"
                required
                value={aYears}
                onChange={(e) => setAYears(e.target.value)}
              />
            </Field>
            <Field label="Optimism bias %">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={aOb}
                onChange={(e) => setAOb(e.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-ink-400">
            Changing the appraisal recomputes every option's NPV, BCR and payback.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setApprOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );

  function renderCreateModal() {
    return (
      <Modal open={createOpen} title="New business case" onClose={() => setCreateOpen(false)}>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Stage">
            <Select value={cStage} onChange={(e) => setCStage(e.target.value)}>
              {STAGES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              required
              value={cTitle}
              onChange={(e) => setCTitle(e.target.value)}
              placeholder="e.g. Riverside depot redevelopment"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Discount rate %" hint="Green Book STPR default 3.5">
              <Input
                type="number"
                min="0"
                max="100"
                step="any"
                required
                value={cRate}
                onChange={(e) => setCRate(e.target.value)}
              />
            </Field>
            <Field label="Appraisal years">
              <Input
                type="number"
                min="1"
                max="60"
                step="1"
                required
                value={cYears}
                onChange={(e) => setCYears(e.target.value)}
              />
            </Field>
            <Field label="Optimism bias %" hint="Uplift applied to capex only.">
              <Input
                type="number"
                min="0"
                step="any"
                required
                value={cOb}
                onChange={(e) => setCOb(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create business case"}
            </Button>
          </div>
        </form>
      </Modal>
    );
  }
}
