/**
 * Safeguards tab — the resettlement depth a lender's supervision mission and
 * an independent RAP monitor actually work from (Domain J #550, #558-561,
 * #568, #575-578).
 *
 * Four registers plus the completion audit:
 *  · Replacement cost — full replacement cost is market value PLUS transaction
 *    costs with NO deduction for depreciation (IFC PS5 para 27). The screen
 *    shows the depreciation a government schedule WOULD have knocked off next
 *    to the answer, because the difference is the finding.
 *  · Heritage & Indigenous Peoples plans (PS7/PS8) with their commitments, and
 *    the chance-find register — a find stops the works until the authority has
 *    spoken, and the register is what proves it did.
 *  · Livelihood restoration measured as income against the pre-displacement
 *    baseline, not as a tick.
 *  · RAP completion audits, each freezing the indicator set AND the ledger
 *    sequence it was built from.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
import EvidencePicker from "./EvidencePicker";

/* ================================ Types ================================== */

interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

interface StudyRow {
  id: string;
  parcelId: string | null;
  papId: string | null;
  assetType: string;
  description: string;
  method: string;
  marketValue: number;
  depreciationDeducted: number;
  transactionCosts: number;
  replacementCost: number;
  compensationOffered: number | null;
  currency: string;
  shortfall: number | null;
  verdict: string;
  surveyDate: string;
  valuerName: string | null;
  valuerIndependentBool: boolean;
}

interface ReplacementSummary {
  total: number;
  currencies: string[];
  byCurrency: {
    currency: string;
    studies: number;
    verified: number;
    adequate: number;
    shortfall: number;
    unverified: number;
    totalReplacementCost: number;
    totalCompensationOffered: number;
    totalShortfall: number;
    adequateSharePercent: number | null;
  }[];
  byAssetType: { assetType: string; studies: number; shortfalls: number }[];
  independentValuerSharePercent: number | null;
}

interface PlanCommitment {
  id: string;
  text: string;
  dueDate: string | null;
  owner: string | null;
  status: string;
  closedAt: string | null;
}

interface PlanRow {
  id: string;
  kind: string;
  title: string;
  subject: string | null;
  status: string;
  consentStatus: string | null;
  commitments: PlanCommitment[];
  commitmentCount?: number;
  openCommitments?: number;
  overdueCommitments?: number;
}

interface ChanceFindRow {
  id: string;
  number: number;
  discoveredAt: string;
  description: string;
  locationDescription: string | null;
  status: string;
  authority: string | null;
  workStoppedAt: string | null;
  authorityNotifiedAt: string | null;
  releasedAt: string | null;
  notified: boolean;
  released: boolean;
}

interface ActivityRow {
  id: string;
  papId: string;
  papReference: string | null;
  kind: string;
  description: string;
  status: string;
  cost: number | null;
  currency: string;
  incomeBaseline: number | null;
  incomeCurrent: number | null;
  incomeRatioPercent: number | null;
  restored: boolean | null;
}

interface AuditRow {
  id: string;
  number: number;
  auditor: string;
  auditorIndependentBool: boolean;
  auditDate: string;
  conclusion: string;
  ledgerSeqTo: number | null;
  findings: { id: string; severity: string; finding: string }[];
}

interface RapIndicators {
  asOf: string;
  parcels: {
    total: number;
    acquired: number;
    compensated: number;
    disputed: number;
    acquiredWithoutBasis: number;
    byAcquisitionBasis: Record<string, number>;
  };
  households: {
    total: number;
    physicallyDisplaced: number;
    vulnerable: number;
    compensated: number;
    compensatedPercent: number | null;
    resettled: number;
    livelihoodRestored: number;
    livelihoodRestoredPercent: number | null;
    resettledWithoutPayment: number;
    /** households with a live complaint against them (#569-574) */
    underOpenGrievance: number;
  };
  replacementCost: {
    studies: number;
    shortfalls: number;
    unverified: number;
    independentValuations: number;
    householdsWithoutStudy: number;
  };
  livelihood: {
    activities: number;
    delivered: number;
    verified: number;
    failed: number;
    householdsWithActivity: number;
  };
  grievances: {
    total: number;
    open: number;
    overdue: number;
    rejected: number;
    verifiedClosures: number;
    satisfactionPercent: number | null;
    anonymous: number;
    escalated: number;
  };
  heritage: {
    plans: number;
    implemented: number;
    openCommitments: number;
    chanceFinds: number;
    chanceFindsUnnotified: number;
    chanceFindsReleased: number;
  };
}

interface Reference {
  acquisitionBases: string[];
}

const VERDICT_TONE: Record<string, "green" | "red" | "gray"> = {
  adequate: "green",
  shortfall: "red",
  unverified: "gray",
};

const FIND_NEXT: Record<string, string | null> = {
  reported: "work_stopped",
  work_stopped: "authority_notified",
  authority_notified: "assessed",
  assessed: "released",
  released: null,
};

const ACTIVITY_NEXT: Record<string, string | null> = {
  planned: "in_progress",
  in_progress: "delivered",
  delivered: "verified",
  verified: null,
  failed: null,
};

type SubView = "replacement" | "heritage" | "livelihood" | "audit";

const SUB_VIEWS: { key: SubView; label: string; hint: string }[] = [
  { key: "replacement", label: "Replacement cost", hint: "#550" },
  { key: "heritage", label: "Heritage & finds", hint: "#575-578" },
  { key: "livelihood", label: "Livelihood", hint: "#561" },
  { key: "audit", label: "RAP audit", hint: "#558-560, #568" },
];

const money = (v: number | null | undefined, currency: string): string =>
  v === null || v === undefined ? "—" : `${v.toLocaleString()} ${currency}`;

/* ================================ Shell ================================== */

export default function SafeguardsTab({
  projectId,
  onChanged,
}: {
  projectId: string;
  onChanged?: () => void;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [view, setView] = useState<SubView>("replacement");
  const [reference, setReference] = useState<Reference | null>(null);

  useEffect(() => {
    api
      .get<Reference>("/api/v1/land/reference")
      .then(setReference)
      .catch(() => setReference(null));
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-ink-200">
        {SUB_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => setView(v.key)}
            className={
              view === v.key
                ? "-mb-px border-b-2 border-brand-600 px-3 py-2 text-sm font-medium text-brand-700"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-500 hover:text-ink-800"
            }
          >
            {v.label}
            <span className="ml-1.5 text-[11px] font-normal text-ink-300">{v.hint}</span>
          </button>
        ))}
      </div>

      {view === "replacement" ? (
        <ReplacementPanel base={base} projectId={projectId} onChanged={onChanged} />
      ) : null}
      {view === "heritage" ? <HeritagePanel base={base} projectId={projectId} /> : null}
      {view === "livelihood" ? <LivelihoodPanel base={base} projectId={projectId} /> : null}
      {view === "audit" ? <AuditPanel base={base} reference={reference} /> : null}
    </div>
  );
}

/* ---------------------------- Replacement -------------------------------- */

function ReplacementPanel({
  base,
  projectId,
  onChanged,
}: {
  base: string;
  projectId: string;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<StudyRow[] | null>(null);
  const [summary, setSummary] = useState<ReplacementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [form, setForm] = useState({
    parcelId: "",
    assetType: "structure",
    description: "",
    method: "independent_valuer",
    marketValue: "",
    depreciationDeducted: "",
    transactionCosts: "",
    compensationOffered: "",
    currency: "USD",
    surveyDate: "",
    valuerName: "",
    valuerIndependent: true,
  });
  const [parcels, setParcels] = useState<{ id: string; reference: string }[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, sum, parcelList] = await Promise.all([
        api.get<ListResponse<StudyRow>>(`${base}/replacement-studies?pageSize=200`),
        api.get<ReplacementSummary>(`${base}/replacement-studies/summary`),
        api.get<ListResponse<{ id: string; reference: string }>>(`${base}/parcels?pageSize=200`),
      ]);
      setRows(list.items);
      setSummary(sum);
      setParcels(parcelList.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load replacement-cost studies");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/replacement-studies`, {
        parcelId: form.parcelId || null,
        assetType: form.assetType,
        description: form.description,
        method: form.method,
        marketValue: Number(form.marketValue),
        depreciationDeducted:
          form.depreciationDeducted === "" ? 0 : Number(form.depreciationDeducted),
        transactionCosts: form.transactionCosts === "" ? 0 : Number(form.transactionCosts),
        compensationOffered:
          form.compensationOffered === "" ? null : Number(form.compensationOffered),
        currency: form.currency,
        surveyDate: form.surveyDate,
        valuerName: form.valuerName || null,
        valuerIndependent: form.valuerIndependent,
        evidenceIds,
      });
      setOpen(false);
      setEvidenceIds([]);
      setForm({ ...form, description: "", marketValue: "", compensationOffered: "" });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the study");
    } finally {
      setSaving(false);
    }
  }

  const canCreate =
    form.parcelId !== "" &&
    form.description.trim() !== "" &&
    form.marketValue !== "" &&
    form.surveyDate !== "";

  return (
    <Card>
      <CardHeader
        title="Replacement-cost verification"
        subtitle="Full replacement cost = market value + transaction costs, with NO deduction for depreciation (IFC PS5 para 27)"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            New study
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {summary && summary.byCurrency.length > 0 ? (
          <div className="mb-4 space-y-2">
            {summary.byCurrency.map((c) => (
              <div
                key={c.currency}
                className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-ink-50 px-3 py-2 text-sm"
              >
                <span className="font-semibold">{c.currency}</span>
                <span>
                  <span className="text-ink-500">replacement cost </span>
                  <span className="tabular-nums">{c.totalReplacementCost.toLocaleString()}</span>
                </span>
                <span>
                  <span className="text-ink-500">offered </span>
                  <span className="tabular-nums">
                    {c.totalCompensationOffered.toLocaleString()}
                  </span>
                </span>
                {c.totalShortfall > 0 ? (
                  <Badge tone="red">shortfall {c.totalShortfall.toLocaleString()}</Badge>
                ) : null}
                <span className="text-ink-500">
                  {c.adequateSharePercent === null
                    ? "nothing verified yet"
                    : `${c.adequateSharePercent}% of verified studies adequate`}
                </span>
              </div>
            ))}
            {summary.independentValuerSharePercent !== null ? (
              <p className="text-xs text-ink-500">
                {summary.independentValuerSharePercent}% of studies were produced by an independent
                valuer — the acquiring authority valuing its own acquisition is the finding a
                supervision mission looks for first.
              </p>
            ) : null}
          </div>
        ) : null}

        {rows === null ? (
          <Spinner label="Loading studies…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No replacement-cost studies"
            description="The commonest adverse finding on a lender supervision mission is that a project paid the government's depreciated schedule rate. Record the market survey behind each asset and the gap becomes visible."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Asset</Th>
                  <Th>Method</Th>
                  <Th className="text-right">Market value</Th>
                  <Th className="text-right">Transaction costs</Th>
                  <Th className="text-right">Replacement cost</Th>
                  <Th className="text-right">Offered</Th>
                  <Th className="text-right">Shortfall</Th>
                  <Th>Verdict</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <div className="font-medium text-ink-900">{r.description}</div>
                      <div className="text-xs text-ink-400">
                        {humanize(r.assetType)} · surveyed {formatDate(r.surveyDate)}
                        {r.valuerIndependentBool ? " · independent valuer" : " · not independent"}
                      </div>
                    </Td>
                    <Td className="text-xs text-ink-600">{humanize(r.method)}</Td>
                    <Td className="text-right tabular-nums">{r.marketValue.toLocaleString()}</Td>
                    <Td className="text-right tabular-nums">
                      {r.transactionCosts.toLocaleString()}
                    </Td>
                    <Td className="text-right font-medium tabular-nums">
                      {r.replacementCost.toLocaleString()}
                      {r.depreciationDeducted > 0 ? (
                        <div
                          className="text-[11px] font-normal text-amber-700"
                          title="Depreciation is carried so the gap against a schedule rate is visible; PS5 para 27 does not permit deducting it."
                        >
                          schedule would deduct {r.depreciationDeducted.toLocaleString()}
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {money(r.compensationOffered, "").trim() || "—"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.shortfall === null ? (
                        "—"
                      ) : r.shortfall > 0 ? (
                        <span className="font-medium text-red-700">
                          {r.shortfall.toLocaleString()}
                        </span>
                      ) : (
                        "0"
                      )}
                    </Td>
                    <Td>
                      <Badge tone={VERDICT_TONE[r.verdict] ?? "gray"}>{humanize(r.verdict)}</Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="New replacement-cost study" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Parcel">
              <Select
                value={form.parcelId}
                onChange={(e) => setForm({ ...form, parcelId: e.target.value })}
              >
                <option value="">Select a parcel…</option>
                {parcels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Asset type">
              <Select
                value={form.assetType}
                onChange={(e) => setForm({ ...form, assetType: e.target.value })}
              >
                {[
                  "land",
                  "structure",
                  "crops",
                  "trees",
                  "business",
                  "fixture",
                  "cultural_asset",
                  "other",
                ].map((t) => (
                  <option key={t} value={t}>
                    {humanize(t)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Three-room brick dwelling with corrugated roof"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Valuation method">
              <Select
                value={form.method}
                onChange={(e) => setForm({ ...form, method: e.target.value })}
              >
                {[
                  "market_survey",
                  "government_schedule",
                  "independent_valuer",
                  "negotiated",
                  "court_determined",
                ].map((m) => (
                  <option key={m} value={m}>
                    {humanize(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Survey date">
              <Input
                type="date"
                value={form.surveyDate}
                onChange={(e) => setForm({ ...form, surveyDate: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Market value">
              <Input
                type="number"
                value={form.marketValue}
                onChange={(e) => setForm({ ...form, marketValue: e.target.value })}
              />
            </Field>
            <Field
              label="Depreciation"
              hint="What a schedule rate would deduct — recorded, never applied"
            >
              <Input
                type="number"
                value={form.depreciationDeducted}
                onChange={(e) => setForm({ ...form, depreciationDeducted: e.target.value })}
              />
            </Field>
            <Field label="Transaction costs" hint="Duty, registration, moving">
              <Input
                type="number"
                value={form.transactionCosts}
                onChange={(e) => setForm({ ...form, transactionCosts: e.target.value })}
              />
            </Field>
            <Field label="Compensation offered" hint="Blank = unverified">
              <Input
                type="number"
                value={form.compensationOffered}
                onChange={(e) => setForm({ ...form, compensationOffered: e.target.value })}
              />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Currency">
              <Input
                value={form.currency}
                maxLength={3}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="Valuer">
              <Input
                value={form.valuerName}
                onChange={(e) => setForm({ ...form, valuerName: e.target.value })}
              />
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.valuerIndependent}
                  onChange={(e) => setForm({ ...form, valuerIndependent: e.target.checked })}
                />
                Independent valuer
              </label>
            </div>
          </div>
          <Field label="Evidence" hint="The market survey behind the figure">
            <EvidencePicker
              projectId={projectId}
              selected={evidenceIds}
              onChange={setEvidenceIds}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={!canCreate || saving}>
              {saving ? "Saving…" : "Record study"}
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------ Heritage --------------------------------- */

function HeritagePanel({ base, projectId }: { base: string; projectId: string }) {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [finds, setFinds] = useState<ChanceFindRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<PlanRow | null>(null);
  const [selectedFind, setSelectedFind] = useState<ChanceFindRow | null>(null);
  const [authority, setAuthority] = useState("");
  const [planForm, setPlanForm] = useState({
    kind: "indigenous_peoples_plan",
    title: "",
    subject: "",
    commitments: "",
  });
  const [findForm, setFindForm] = useState({
    discoveredAt: "",
    description: "",
    locationDescription: "",
    stopWork: true,
  });
  void projectId;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, f] = await Promise.all([
        api.get<ListResponse<PlanRow>>(`${base}/heritage-plans?pageSize=100`),
        api.get<ListResponse<ChanceFindRow>>(`${base}/chance-finds?pageSize=100`),
      ]);
      setPlans(p.items);
      setFinds(f.items);
    } catch (err) {
      setPlans([]);
      setFinds([]);
      setError(err instanceof Error ? err.message : "Failed to load heritage records");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createPlan() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/heritage-plans`, {
        kind: planForm.kind,
        title: planForm.title,
        subject: planForm.subject || null,
        commitments: planForm.commitments
          .split("\n")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((text) => ({ text })),
      });
      setPlanOpen(false);
      setPlanForm({ ...planForm, title: "", subject: "", commitments: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the plan");
    } finally {
      setSaving(false);
    }
  }

  async function createFind() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/chance-finds`, {
        discoveredAt: findForm.discoveredAt,
        description: findForm.description,
        locationDescription: findForm.locationDescription || null,
        stopWork: findForm.stopWork,
      });
      setFindOpen(false);
      setFindForm({ ...findForm, discoveredAt: "", description: "", locationDescription: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the find");
    } finally {
      setSaving(false);
    }
  }

  async function closeCommitment(planId: string, commitmentId: string) {
    setError(null);
    try {
      await api.post(`${base}/heritage-plans/${planId}/commitments/${commitmentId}/close`, {});
      const detail = await api.get<PlanRow>(`${base}/heritage-plans/${planId}`);
      setSelectedPlan(detail);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close the commitment");
    }
  }

  async function advanceFind(status: string) {
    if (!selectedFind) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/chance-finds/${selectedFind.id}/status`, {
        status,
        ...(status === "authority_notified" ? { authority } : {}),
      });
      setSelectedFind(null);
      setAuthority("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transition was refused");
    } finally {
      setSaving(false);
    }
  }

  const findNext = selectedFind ? FIND_NEXT[selectedFind.status] : null;

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      <Card>
        <CardHeader
          title="Indigenous Peoples & cultural heritage plans"
          subtitle="IFC PS7 / PS8 — a plan whose commitments nobody tracks is a document, not a safeguard"
          actions={
            <Button size="sm" onClick={() => setPlanOpen(true)}>
              New plan
            </Button>
          }
        />
        <CardBody>
          {plans === null ? (
            <Spinner label="Loading plans…" />
          ) : plans.length === 0 ? (
            <EmptyState
              title="No heritage plans"
              description="Where PS7 or PS8 is engaged, the plan and its commitments belong here so the completion audit can test them."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Plan</Th>
                    <Th>Kind</Th>
                    <Th>Status</Th>
                    <Th>FPIC</Th>
                    <Th className="text-right">Commitments</Th>
                    <Th className="text-right">Open</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {plans.map((p) => (
                    <tr
                      key={p.id}
                      className="cursor-pointer hover:bg-ink-50/60"
                      onClick={() => {
                        void api
                          .get<PlanRow>(`${base}/heritage-plans/${p.id}`)
                          .then(setSelectedPlan)
                          .catch(() => setSelectedPlan(p));
                      }}
                    >
                      <Td className="font-medium text-ink-900">{p.title}</Td>
                      <Td className="text-ink-600">{humanize(p.kind)}</Td>
                      <Td>
                        <Badge
                          tone={
                            p.status === "implemented" || p.status === "closed" ? "green" : "blue"
                          }
                        >
                          {humanize(p.status)}
                        </Badge>
                      </Td>
                      <Td className="text-ink-600">
                        {p.consentStatus ? humanize(p.consentStatus) : "—"}
                      </Td>
                      <Td className="text-right tabular-nums">{p.commitmentCount ?? 0}</Td>
                      <Td className="text-right">
                        {(p.overdueCommitments ?? 0) > 0 ? (
                          <Badge tone="red">{p.overdueCommitments} overdue</Badge>
                        ) : (
                          <span className="tabular-nums">{p.openCommitments ?? 0}</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Chance finds"
          subtitle="IFC PS8 para 16 — the works stop until the competent authority has spoken"
          actions={
            <Button size="sm" onClick={() => setFindOpen(true)}>
              Report a find
            </Button>
          }
        />
        <CardBody>
          {finds === null ? (
            <Spinner label="Loading chance finds…" />
          ) : finds.length === 0 ? (
            <EmptyState
              title="No chance finds"
              description="An unreported find is a criminal offence in most jurisdictions and destroys the evidence that would have justified the stoppage."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Ref</Th>
                    <Th>Discovered</Th>
                    <Th>Description</Th>
                    <Th>Work stopped</Th>
                    <Th>Authority</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {finds.map((f) => (
                    <tr
                      key={f.id}
                      className="cursor-pointer hover:bg-ink-50/60"
                      onClick={() => setSelectedFind(f)}
                    >
                      <Td className="whitespace-nowrap font-medium tabular-nums text-ink-900">
                        CF-{f.number}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDate(f.discoveredAt)}
                      </Td>
                      <Td className="text-ink-700">{f.description}</Td>
                      <Td>
                        {f.workStoppedAt ? (
                          <Badge tone="green">yes</Badge>
                        ) : (
                          <Badge tone="red">no</Badge>
                        )}
                      </Td>
                      <Td>
                        {f.notified ? (
                          <span className="text-xs text-ink-600">{f.authority ?? "notified"}</span>
                        ) : (
                          <Badge tone="red">not notified</Badge>
                        )}
                      </Td>
                      <Td>
                        <Badge tone={f.released ? "green" : "amber"}>{humanize(f.status)}</Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal open={planOpen} onClose={() => setPlanOpen(false)} title="New heritage plan">
        <div className="space-y-3">
          <Field label="Kind">
            <Select
              value={planForm.kind}
              onChange={(e) => setPlanForm({ ...planForm, kind: e.target.value })}
            >
              {[
                "indigenous_peoples_plan",
                "cultural_heritage_management_plan",
                "chance_find_procedure",
                "fpic_process",
                "community_development_plan",
              ].map((k) => (
                <option key={k} value={k}>
                  {humanize(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              value={planForm.title}
              onChange={(e) => setPlanForm({ ...planForm, title: e.target.value })}
            />
          </Field>
          <Field label="Subject" hint="The community, group or asset the plan is for">
            <Input
              value={planForm.subject}
              onChange={(e) => setPlanForm({ ...planForm, subject: e.target.value })}
            />
          </Field>
          <Field label="Commitments" hint="One per line — each becomes a tracked commitment">
            <Textarea
              rows={4}
              value={planForm.commitments}
              onChange={(e) => setPlanForm({ ...planForm, commitments: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createPlan()}
              disabled={saving || planForm.title.trim() === ""}
            >
              {saving ? "Saving…" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={findOpen} onClose={() => setFindOpen(false)} title="Report a chance find">
        <div className="space-y-3">
          <Field label="Discovered on">
            <Input
              type="date"
              value={findForm.discoveredAt}
              onChange={(e) => setFindForm({ ...findForm, discoveredAt: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={findForm.description}
              onChange={(e) => setFindForm({ ...findForm, description: e.target.value })}
              placeholder="Pottery sherds and a possible burial cist at the cutting face"
            />
          </Field>
          <Field label="Location">
            <Input
              value={findForm.locationDescription}
              onChange={(e) => setFindForm({ ...findForm, locationDescription: e.target.value })}
              placeholder="Ch 3+120"
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={findForm.stopWork}
              onChange={(e) => setFindForm({ ...findForm, stopWork: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Works stopped in the affected area
              <span className="block text-xs text-ink-500">
                PS8 para 16 makes the stoppage the norm; recording a find without one is a
                deliberate choice.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFindOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createFind()}
              disabled={
                saving || findForm.discoveredAt === "" || findForm.description.trim() === ""
              }
            >
              {saving ? "Saving…" : "Report"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={selectedPlan !== null}
        onClose={() => setSelectedPlan(null)}
        title={selectedPlan?.title ?? ""}
        wide
      >
        {selectedPlan ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-500">
              {humanize(selectedPlan.kind)}
              {selectedPlan.subject ? ` — ${selectedPlan.subject}` : ""}
            </p>
            {selectedPlan.commitments.length === 0 ? (
              <EmptyState title="No commitments" description="This plan carries no commitments." />
            ) : (
              <ul className="space-y-2">
                {selectedPlan.commitments.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-ink-100 p-2 text-sm"
                  >
                    <div>
                      <div>{c.text}</div>
                      <div className="text-xs text-ink-400">
                        {c.dueDate ? `due ${formatDate(c.dueDate)}` : "no due date"}
                        {c.closedAt ? ` · closed ${formatDate(c.closedAt)}` : ""}
                      </div>
                    </div>
                    {c.status === "closed" ? (
                      <Badge tone="green">closed</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void closeCommitment(selectedPlan.id, c.id)}
                      >
                        Close
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={selectedFind !== null}
        onClose={() => setSelectedFind(null)}
        title={selectedFind ? `CF-${selectedFind.number}` : ""}
      >
        {selectedFind ? (
          <div className="space-y-3">
            <p className="text-sm">{selectedFind.description}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-500">Discovered</dt>
              <dd>{formatDate(selectedFind.discoveredAt)}</dd>
              <dt className="text-ink-500">Work stopped</dt>
              <dd>
                {selectedFind.workStoppedAt ? formatDate(selectedFind.workStoppedAt) : "not stopped"}
              </dd>
              <dt className="text-ink-500">Authority notified</dt>
              <dd>
                {selectedFind.authorityNotifiedAt
                  ? `${selectedFind.authority ?? "notified"} — ${formatDate(selectedFind.authorityNotifiedAt)}`
                  : "not yet"}
              </dd>
            </dl>
            {findNext ? (
              <div className="space-y-2">
                {findNext === "authority_notified" ? (
                  <Field label="Authority">
                    <Input
                      value={authority}
                      onChange={(e) => setAuthority(e.target.value)}
                      placeholder="National Museums Service"
                    />
                  </Field>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => void advanceFind(findNext)}
                  disabled={
                    saving || (findNext === "authority_notified" && authority.trim() === "")
                  }
                >
                  Mark {humanize(findNext)}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-ink-500">The area has been released.</p>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

/* ----------------------------- Livelihood -------------------------------- */

function LivelihoodPanel({ base, projectId }: { base: string; projectId: string }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [paps, setPaps] = useState<{ id: string; reference: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<ActivityRow | null>(null);
  const [incomeCurrent, setIncomeCurrent] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [form, setForm] = useState({
    papId: "",
    kind: "skills_training",
    description: "",
    cost: "",
  });

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, papList] = await Promise.all([
        api.get<ListResponse<ActivityRow>>(`${base}/livelihood-activities?pageSize=200`),
        api.get<ListResponse<{ id: string; reference: string }>>(
          `${base}/affected-persons?pageSize=200`,
        ),
      ]);
      setRows(list.items);
      setPaps(papList.items);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load livelihood activities");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/livelihood-activities`, {
        papId: form.papId,
        kind: form.kind,
        description: form.description,
        cost: form.cost === "" ? null : Number(form.cost),
      });
      setOpen(false);
      setForm({ ...form, description: "", cost: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the activity");
    } finally {
      setSaving(false);
    }
  }

  async function advance(status: string) {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/livelihood-activities/${selected.id}/status`, {
        status,
        ...(incomeCurrent === "" ? {} : { incomeCurrent: Number(incomeCurrent) }),
        ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
      });
      setSelected(null);
      setIncomeCurrent("");
      setEvidenceIds([]);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The transition was refused");
    } finally {
      setSaving(false);
    }
  }

  const next = selected ? ACTIVITY_NEXT[selected.status] : null;

  return (
    <Card>
      <CardHeader
        title="Livelihood restoration"
        subtitle="IFC PS5 paras 27-29 — restoration is measured income against the pre-displacement baseline, not a tick"
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            New activity
          </Button>
        }
      />
      <CardBody>
        <ErrorAlert message={error} />
        {rows === null ? (
          <Spinner label="Loading activities…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No livelihood activities"
            description="Economically displaced households need a restoration programme whose outcome is measured. Record what was delivered and the income it produced."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>Household</Th>
                  <Th>Activity</Th>
                  <Th>Kind</Th>
                  <Th className="text-right">Baseline income</Th>
                  <Th className="text-right">Current</Th>
                  <Th className="text-right">Ratio</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer hover:bg-ink-50/60"
                    onClick={() => setSelected(r)}
                  >
                    <Td className="whitespace-nowrap font-medium text-ink-900">
                      {r.papReference ?? r.papId}
                    </Td>
                    <Td className="text-ink-700">{r.description}</Td>
                    <Td className="text-xs text-ink-600">{humanize(r.kind)}</Td>
                    <Td className="text-right tabular-nums">
                      {r.incomeBaseline === null ? (
                        <span
                          className="text-ink-400"
                          title="No pre-displacement baseline income is recorded on this household, so restoration cannot be measured against anything."
                        >
                          not recorded
                        </span>
                      ) : (
                        r.incomeBaseline.toLocaleString()
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.incomeCurrent === null ? "—" : r.incomeCurrent.toLocaleString()}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {r.incomeRatioPercent === null ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <span
                          className={
                            r.restored ? "font-medium text-emerald-700" : "text-amber-700"
                          }
                        >
                          {r.incomeRatioPercent}%
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          r.status === "verified"
                            ? "green"
                            : r.status === "failed"
                              ? "red"
                              : r.status === "delivered"
                                ? "blue"
                                : "gray"
                        }
                      >
                        {humanize(r.status)}
                      </Badge>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </CardBody>

      <Modal open={open} onClose={() => setOpen(false)} title="New livelihood activity">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Household">
              <Select
                value={form.papId}
                onChange={(e) => setForm({ ...form, papId: e.target.value })}
              >
                <option value="">Select a household…</option>
                {paps.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                {[
                  "land_for_land",
                  "skills_training",
                  "business_grant",
                  "employment",
                  "transitional_allowance",
                  "agricultural_input",
                  "microfinance",
                  "market_access",
                  "other",
                ].map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Description">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Grant plus market stall licence"
            />
          </Field>
          <Field label="Cost">
            <Input
              type="number"
              value={form.cost}
              onChange={(e) => setForm({ ...form, cost: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void create()}
              disabled={saving || form.papId === "" || form.description.trim() === ""}
            >
              {saving ? "Saving…" : "Create"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.description : ""}
      >
        {selected ? (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-500">Household</dt>
              <dd>{selected.papReference ?? selected.papId}</dd>
              <dt className="text-ink-500">Status</dt>
              <dd>{humanize(selected.status)}</dd>
              <dt className="text-ink-500">Baseline income</dt>
              <dd>{selected.incomeBaseline?.toLocaleString() ?? "not recorded"}</dd>
            </dl>
            {next === "verified" ? (
              <>
                <Field
                  label="Measured household income"
                  hint="Verification without a measurement is an assertion with no evidence"
                >
                  <Input
                    type="number"
                    value={incomeCurrent}
                    onChange={(e) => setIncomeCurrent(e.target.value)}
                  />
                </Field>
                <Field label="Evidence of the measurement">
                  <EvidencePicker
                    projectId={projectId}
                    selected={evidenceIds}
                    onChange={setEvidenceIds}
                  />
                </Field>
              </>
            ) : null}
            {next ? (
              <Button
                size="sm"
                onClick={() => void advance(next)}
                disabled={
                  saving ||
                  (next === "verified" && (incomeCurrent === "" || evidenceIds.length === 0))
                }
              >
                Mark {humanize(next)}
              </Button>
            ) : (
              <p className="text-sm text-ink-500">This activity has reached its final state.</p>
            )}
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* -------------------------------- Audit ---------------------------------- */

function AuditPanel({ base, reference }: { base: string; reference: Reference | null }) {
  const [indicators, setIndicators] = useState<RapIndicators | null>(null);
  const [audits, setAudits] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    auditor: "",
    auditorIndependent: true,
    conclusion: "not_assessed",
    scope: "",
  });
  void reference;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ind, list] = await Promise.all([
        api.get<RapIndicators>(`${base}/land/rap-indicators`),
        api.get<ListResponse<AuditRow>>(`${base}/rap-audits?pageSize=50`),
      ]);
      setIndicators(ind);
      setAudits(list.items);
    } catch (err) {
      setAudits([]);
      setError(err instanceof Error ? err.message : "Failed to load the RAP audit view");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`${base}/rap-audits`, {
        auditor: form.auditor,
        auditorIndependent: form.auditorIndependent,
        conclusion: form.conclusion,
        scope: form.scope || null,
      });
      setOpen(false);
      setForm({ ...form, auditor: "", scope: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the audit");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <ErrorAlert message={error} />

      <Card>
        <CardHeader
          title="RAP indicators"
          subtitle={
            indicators
              ? `Computed from the register as at ${formatDate(indicators.asOf)} — the same arithmetic an audit freezes`
              : "Computed from the register"
          }
        />
        <CardBody>
          {indicators === null ? (
            <Spinner label="Computing indicators…" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <IndicatorBlock
                title="Parcels"
                rows={[
                  ["Total", indicators.parcels.total],
                  ["Acquired", indicators.parcels.acquired],
                  ["Compensated", indicators.parcels.compensated],
                  ["Disputed", indicators.parcels.disputed],
                  [
                    "Acquired with no basis recorded",
                    indicators.parcels.acquiredWithoutBasis,
                    indicators.parcels.acquiredWithoutBasis > 0,
                  ],
                ]}
              />
              <IndicatorBlock
                title="Households"
                rows={[
                  ["Total", indicators.households.total],
                  ["Physically displaced", indicators.households.physicallyDisplaced],
                  ["Vulnerable", indicators.households.vulnerable],
                  [
                    "Compensated",
                    indicators.households.compensatedPercent === null
                      ? "—"
                      : `${indicators.households.compensated} (${indicators.households.compensatedPercent}%)`,
                  ],
                  [
                    "Resettled with no payment on file",
                    indicators.households.resettledWithoutPayment,
                    indicators.households.resettledWithoutPayment > 0,
                  ],
                  [
                    "Livelihood restored",
                    indicators.households.livelihoodRestoredPercent === null
                      ? "—"
                      : `${indicators.households.livelihoodRestored} (${indicators.households.livelihoodRestoredPercent}%)`,
                  ],
                  [
                    "Under an open grievance",
                    indicators.households.underOpenGrievance,
                    indicators.households.underOpenGrievance > 0,
                  ],
                ]}
              />
              <IndicatorBlock
                title="Replacement cost"
                rows={[
                  ["Studies", indicators.replacementCost.studies],
                  ["Shortfalls", indicators.replacementCost.shortfalls, indicators.replacementCost.shortfalls > 0],
                  ["Unverified", indicators.replacementCost.unverified],
                  ["Independent valuations", indicators.replacementCost.independentValuations],
                  ["Households with no study", indicators.replacementCost.householdsWithoutStudy],
                ]}
              />
              <IndicatorBlock
                title="Livelihood"
                rows={[
                  ["Activities", indicators.livelihood.activities],
                  ["Delivered", indicators.livelihood.delivered],
                  ["Verified", indicators.livelihood.verified],
                  ["Failed", indicators.livelihood.failed, indicators.livelihood.failed > 0],
                ]}
              />
              <IndicatorBlock
                title="Grievances"
                rows={[
                  ["Total", indicators.grievances.total],
                  ["Open", indicators.grievances.open],
                  ["Past SLA", indicators.grievances.overdue, indicators.grievances.overdue > 0],
                  ["Escalated", indicators.grievances.escalated],
                  [
                    "Satisfaction",
                    indicators.grievances.satisfactionPercent === null
                      ? "not measured"
                      : `${indicators.grievances.satisfactionPercent}%`,
                  ],
                ]}
              />
              <IndicatorBlock
                title="Heritage"
                rows={[
                  ["Plans", indicators.heritage.plans],
                  ["Implemented", indicators.heritage.implemented],
                  ["Open commitments", indicators.heritage.openCommitments],
                  ["Chance finds", indicators.heritage.chanceFinds],
                  [
                    "Not notified",
                    indicators.heritage.chanceFindsUnnotified,
                    indicators.heritage.chanceFindsUnnotified > 0,
                  ],
                ]}
              />
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Completion audits"
          subtitle="Each freezes the indicator set and the ledger sequence it was built from, so an auditor can replay it"
          actions={
            <Button size="sm" onClick={() => setOpen(true)}>
              Record audit
            </Button>
          }
        />
        <CardBody>
          {audits === null ? (
            <Spinner label="Loading audits…" />
          ) : audits.length === 0 ? (
            <EmptyState
              title="No RAP audits"
              description="An independent completion audit is the instrument that closes a Resettlement Action Plan."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Ref</Th>
                    <Th>Date</Th>
                    <Th>Auditor</Th>
                    <Th>Conclusion</Th>
                    <Th className="text-right">Findings</Th>
                    <Th className="text-right">Ledger seq</Th>
                    <Th>Pack</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {audits.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap font-medium tabular-nums text-ink-900">
                        RAP-{a.number}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-ink-500">
                        {formatDate(a.auditDate)}
                      </Td>
                      <Td className="text-ink-700">
                        {a.auditor}
                        {a.auditorIndependentBool ? (
                          <Badge tone="green" className="ml-2">
                            independent
                          </Badge>
                        ) : (
                          <Badge tone="amber" className="ml-2">
                            not independent
                          </Badge>
                        )}
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            a.conclusion === "complete"
                              ? "green"
                              : a.conclusion === "incomplete"
                                ? "red"
                                : "gray"
                          }
                        >
                          {humanize(a.conclusion)}
                        </Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{a.findings.length}</Td>
                      <Td className="text-right tabular-nums text-ink-500">
                        {a.ledgerSeqTo ?? "—"}
                      </Td>
                      <Td>
                        <a
                          className="text-xs font-medium text-brand-700 underline underline-offset-2"
                          href={`${base}/rap-audits/${a.id}/pack.csv`}
                        >
                          CSV
                        </a>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Record a RAP audit">
        <div className="space-y-3">
          <Field label="Auditor">
            <Input
              value={form.auditor}
              onChange={(e) => setForm({ ...form, auditor: e.target.value })}
              placeholder="Independent Monitor Ltd"
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.auditorIndependent}
              onChange={(e) => setForm({ ...form, auditorIndependent: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              Independent of the implementing agency
              <span className="block text-xs text-ink-500">
                An agency auditing its own resettlement is not an independent completion audit.
              </span>
            </span>
          </label>
          <Field label="Conclusion">
            <Select
              value={form.conclusion}
              onChange={(e) => setForm({ ...form, conclusion: e.target.value })}
            >
              {["complete", "substantially_complete", "incomplete", "not_assessed"].map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Scope">
            <Textarea
              rows={3}
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={saving || form.auditor.trim() === ""}>
              {saving ? "Saving…" : "Record"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function IndicatorBlock({
  title,
  rows,
}: {
  title: string;
  rows: [string, string | number, boolean?][];
}) {
  return (
    <div className="rounded-lg border border-ink-100 p-3">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{title}</h4>
      <dl className="space-y-1 text-sm">
        {rows.map(([label, value, alarming]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-600">{label}</dt>
            <dd
              className={`tabular-nums ${alarming ? "font-semibold text-red-700" : "text-ink-900"}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
