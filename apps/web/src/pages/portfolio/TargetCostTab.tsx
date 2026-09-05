/**
 * TARGET COST AND PAIN/GAIN (#1061–#1062).
 *
 * Sign convention, stated on the page as well as in the engine, so nobody has
 * to guess: a POSITIVE variance is an overrun (pain), the contractor's share
 * is always a non-negative magnitude, and `contractorAdjustment` is the signed
 * movement in what the contractor is paid.
 *
 * Every computation prints its BASIS — the adjusted target, the fee, the
 * variance, the bands the variance was integrated through, and any cap that
 * bound — because a settlement figure without its arithmetic is not a
 * settlement figure.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Td,
  Th,
  toast,
  type DataColumns,
} from "../../ui";
import { IconPlus, IconTrendUp } from "../../ui/icons";
import {
  Basis,
  DASH,
  LoadError,
  PAIN_GAIN_MECHANISMS,
  ReasonList,
  Row,
  dateTime,
  money,
  moneyShort,
  num,
  pct,
  projectApi,
  statusTone,
  titleCase,
  useAction,
  useResource,
  type PainGainCalculation,
  type Paginated,
  type TargetCost,
} from "./portfolioShared";

export default function TargetCostTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const list = useResource<Paginated<TargetCost>>(
    `/api/v1/projects/${projectId}/portfolio/target-costs?page=1&pageSize=100`,
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Target-cost models"
          subtitle="A positive variance is an overrun the contractor shares in; a negative one is a saving. A variance that runs past the last declared band is attributed wholly to the client and said so — extending the last band's rate would invent a contract term."
          actions={
            <Button size="sm" icon={IconPlus} onClick={() => setCreating(true)}>
              New target cost
            </Button>
          }
        />
        <CardBody flush>
          {list.error ? (
            <div className="p-4">
              <LoadError message={list.error} onRetry={list.reload} />
            </div>
          ) : !list.loading && (list.data?.items.length ?? 0) === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={IconTrendUp}
                title="No target-cost model"
                description="Record the target, the fee and the share bands, and the pain/gain position is computed from the defined cost with every step of the arithmetic printed next to it."
                action={<Button onClick={() => setCreating(true)}>Add a target cost</Button>}
              />
            </div>
          ) : (
            <div className="divide-y divide-border">
              {(list.data?.items ?? []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setOpenId(t.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-surface-hover"
                >
                  <div>
                    <div className="font-semibold text-content">
                      {t.name}
                      {t.isAlliance === 1 ? (
                        <Badge tone="info" size="xs" className="ml-2">
                          alliance
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-2xs text-content-subtle">
                      {t.contractReference ?? titleCase(t.mechanism)} · {t.currency} ·{" "}
                      {num(t.shareBands.length)} band{t.shareBands.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-meta">
                    {t.position && t.position.computable ? (
                      <>
                        <span className="text-content-muted">
                          Target{" "}
                          <span className="font-semibold text-content">
                            {moneyShort(t.position.adjustedTarget, t.currency)}
                          </span>
                        </span>
                        <span className="text-content-muted">
                          Forecast{" "}
                          <span className="font-semibold text-content">
                            {moneyShort(t.position.outturnCost, t.currency)}
                          </span>
                        </span>
                        <Badge
                          tone={t.position.side === "pain" ? "danger" : t.position.side === "gain" ? "success" : "neutral"}
                          size="xs"
                          dot
                        >
                          {titleCase(t.position.side)} {pct(t.position.variancePercent)}
                        </Badge>
                      </>
                    ) : (
                      <Badge tone="warning" size="xs">
                        not computable
                      </Badge>
                    )}
                    <Badge tone={statusTone(t.status)} size="xs">
                      {titleCase(t.status)}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <TargetCostDrawer
        projectId={projectId}
        targetCostId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => {
          list.reload();
          onChanged();
        }}
      />
      <TargetCostCreateDrawer
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          list.reload();
          onChanged();
          setOpenId(id);
        }}
      />
    </div>
  );
}

function TargetCostDrawer({
  projectId,
  targetCostId,
  onClose,
  onChanged,
}: {
  projectId: string;
  targetCostId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [basis, setBasis] = useState<"forecast" | "actual">("forecast");
  const detail = useResource<TargetCost>(
    targetCostId
      ? `/api/v1/projects/${projectId}/portfolio/target-costs/${targetCostId}?basis=${basis}`
      : null,
  );
  const api = projectApi(projectId);
  const action = useAction();
  const [note, setNote] = useState("");

  useEffect(() => {
    setNote("");
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetCostId]);

  const t = detail.data;
  const p = t?.position ?? null;

  const calcColumns = useMemo<DataColumns<PainGainCalculation>>(
    () => [
      { id: "createdAt", header: "Frozen", accessor: "createdAt", type: "datetime", width: 180, cell: ({ row }) => dateTime(row.createdAt) },
      { id: "basis", header: "Basis", accessor: (r) => titleCase(r.basis), type: "text", width: 110 },
      {
        id: "adjustedTarget",
        header: "Adjusted target",
        accessor: "adjustedTarget",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.adjustedTarget, row.currency),
      },
      {
        id: "outturnCost",
        header: "Outturn",
        accessor: "outturnCost",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.outturnCost, row.currency),
      },
      {
        id: "variance",
        header: "Variance",
        accessor: "variance",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => (
          <span className={row.variance > 0 ? "font-semibold text-danger-text" : "text-success-text"}>
            {moneyShort(row.variance, row.currency)}
          </span>
        ),
      },
      {
        id: "contractorShare",
        header: "Contractor share",
        accessor: "contractorShare",
        type: "number",
        align: "right",
        width: 160,
        cell: ({ row }) => moneyShort(row.contractorShare, row.currency),
      },
      {
        id: "clientShare",
        header: "Client share",
        accessor: "clientShare",
        type: "number",
        align: "right",
        width: 150,
        cell: ({ row }) => moneyShort(row.clientShare, row.currency),
      },
    ],
    [],
  );

  async function calculate(freeze: boolean) {
    if (!targetCostId) return;
    const res = await action.run(freeze ? "freeze" : "calc", () =>
      api.calculate(targetCostId, { basis, freeze, note: note || undefined }),
    );
    if (res) {
      toast.success(
        res.frozen
          ? "Calculation frozen — the settlement figure can no longer drift"
          : "Computed (nothing frozen)",
      );
      detail.reload();
      onChanged();
    }
  }

  async function setStatus(status: string) {
    if (!targetCostId) return;
    const res = await action.run(status, () => api.setTargetCostStatus(targetCostId, { status }));
    if (res) {
      toast.success(`Marked ${status.replace(/_/g, " ")}`);
      detail.reload();
      onChanged();
    }
  }

  return (
    <Drawer
      open={targetCostId !== null}
      onClose={onClose}
      size="xl"
      title={t ? t.name : "Target cost"}
      description={t ? `${t.contractReference ?? titleCase(t.mechanism)} · ${t.currency} · ${titleCase(t.status)}` : undefined}
    >
      {detail.error ? (
        <LoadError message={detail.error} onRetry={detail.reload} />
      ) : !t ? (
        <div className="text-meta text-content-subtle">Loading…</div>
      ) : (
        <div className="space-y-4">
          {action.error ? (
            <Alert tone="danger" size="sm">
              {action.error}
            </Alert>
          ) : null}
          {t.modelWarnings && t.modelWarnings.length > 0 ? (
            <Alert tone="warning" size="sm" title="Model warnings">
              <ReasonList reasons={t.modelWarnings} />
            </Alert>
          ) : null}

          <div className="flex items-end gap-2">
            <Field label="Compute against">
              <Select value={basis} onChange={(e) => setBasis(e.target.value as "forecast" | "actual")} size="sm">
                <option value="forecast">Forecast defined cost</option>
                <option value="actual">Actual defined cost to date</option>
              </Select>
            </Field>
            <Button size="sm" variant="secondary" onClick={() => void calculate(false)} loading={action.busy === "calc"}>
              Recompute
            </Button>
            <Button size="sm" onClick={() => void calculate(true)} loading={action.busy === "freeze"}>
              Freeze this calculation
            </Button>
          </div>
          <Field label="Note on the frozen calculation">
            <Input value={note} onChange={(e) => setNote(e.target.value)} size="sm" placeholder="e.g. Final account position" />
          </Field>

          {!p || !p.computable ? (
            <Alert tone="warning" size="sm" title="The position cannot be computed">
              <ReasonList reasons={p?.reasons ?? [t.positionReason ?? "The stored model is not a valid apportionment."]} />
            </Alert>
          ) : (
            <>
              <dl className="divide-y divide-border">
                <Row label="Base target">{money(t.baseTargetCost, t.currency)}</Row>
                <Row label="Agreed adjustments">{money(t.targetAdjustments, t.currency)}</Row>
                <Row label="Adjusted target">
                  <span className="font-semibold">{money(p.adjustedTarget, t.currency)}</span>
                </Row>
                <Row label={basis === "actual" ? "Actual defined cost" : "Forecast defined cost"}>
                  {money(p.outturnCost, t.currency)}
                </Row>
                <Row label="Variance" hint="positive is an overrun (pain), negative is a saving (gain)">
                  <span className={p.side === "pain" ? "font-semibold text-danger-text" : "font-semibold text-success-text"}>
                    {money(p.variance, t.currency)} ({pct(p.variancePercent)})
                  </span>
                </Row>
                <Row label="Fee">{money(p.fee, t.currency)}</Row>
                <Row label="Contractor share of the variance">
                  {p.contractorShare === null ? DASH : money(p.contractorShare, t.currency)}
                </Row>
                <Row label="Client share of the variance">
                  {p.clientShare === null ? DASH : money(p.clientShare, t.currency)}
                </Row>
                <Row label="Contractor adjustment" hint="signed movement in what the contractor is paid">
                  {p.contractorAdjustment === null ? DASH : money(p.contractorAdjustment, t.currency)}
                </Row>
                <Row label="Contractor payment" hint="defined cost + fee + adjustment">
                  {p.contractorPayment === null ? DASH : money(p.contractorPayment, t.currency)}
                </Row>
                {p.capApplied ? (
                  <Row
                    label={`${titleCase(p.capApplied)} cap applied`}
                    hint={`${money(p.capTransfer, t.currency)} transferred to the client`}
                  >
                    {money(p.cappedAt, t.currency)}
                  </Row>
                ) : null}
              </dl>

              <div>
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                  Variance integrated through the bands
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <tr>
                        <Th>Band</Th>
                        <Th align="right">Contractor %</Th>
                        <Th align="right">In band</Th>
                        <Th align="right">Contractor</Th>
                        <Th align="right">Client</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.bands.map((b, i) => (
                        <tr key={i}>
                          <Td>
                            {b.fromPercent}% → {b.toPercent === null ? "open" : `${b.toPercent}%`}
                          </Td>
                          <Td align="right">{b.contractorSharePercent}%</Td>
                          <Td align="right">{moneyShort(b.amountInBand, t.currency)}</Td>
                          <Td align="right">{moneyShort(b.contractorAmount, t.currency)}</Td>
                          <Td align="right">{moneyShort(b.clientAmount, t.currency)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </div>

              {p.participants.length > 0 ? (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                    Alliance split of the contractor side
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <thead>
                        <tr>
                          <Th>Participant</Th>
                          <Th align="right">Share</Th>
                          <Th align="right">Amount</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.participants.map((x, i) => (
                          <tr key={i}>
                            <Td>{x.name}</Td>
                            <Td align="right">{pct(x.sharePercent)}</Td>
                            <Td align="right">
                              <span className={x.amount < 0 ? "text-danger-text" : "text-success-text"}>
                                {moneyShort(x.amount, t.currency)}
                              </span>
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </div>
              ) : null}

              <Basis lines={p.basis} title="How this number was arrived at" />
              {p.warnings.length > 0 ? (
                <Alert tone="warning" size="sm" title={`${p.warnings.length} warning${p.warnings.length === 1 ? "" : "s"}`}>
                  <ReasonList reasons={p.warnings} />
                </Alert>
              ) : null}
            </>
          )}

          {t.calculations && t.calculations.length > 0 ? (
            <div>
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">
                Frozen calculations
              </div>
              <DataTable<PainGainCalculation>
                tableId="portfolio.pain-gain"
                data={t.calculations}
                columns={calcColumns}
                getRowId={(row) => row.id}
                height={220}
                rowHeight={40}
                stickyHeader
                toolbar={false}
                empty={{ title: "Nothing frozen yet" }}
                aria-label="Frozen pain-gain calculations"
              />
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {["active", "final_account", "closed"]
              .filter((s) => s !== t.status)
              .map((s) => (
                <Button key={s} size="sm" variant="ghost" onClick={() => void setStatus(s)} loading={action.busy === s}>
                  Mark {s.replace(/_/g, " ")}
                </Button>
              ))}
          </div>
          <p className="text-2xs text-content-subtle">
            Closing the final account requires a frozen calculation and a different person from whoever set the model
            up; a settlement with no recorded computation cannot be defended.
          </p>
        </div>
      )}
    </Drawer>
  );
}

/* =============================== Create =================================== */

interface DraftBand {
  fromPercent: string;
  toPercent: string;
  contractorSharePercent: string;
}

function TargetCostCreateDrawer({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const action = useAction();
  const api = projectApi(projectId);
  const [form, setForm] = useState<Record<string, string>>({ mechanism: "banded_share" });
  const [bands, setBands] = useState<DraftBand[]>([
    { fromPercent: "-100", toPercent: "0", contractorSharePercent: "50" },
    { fromPercent: "0", toPercent: "5", contractorSharePercent: "50" },
    { fromPercent: "5", toPercent: "", contractorSharePercent: "20" },
  ]);
  const [participants, setParticipants] = useState<Array<{ name: string; sharePercent: string }>>([]);

  useEffect(() => {
    setForm({ mechanism: "banded_share" });
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const numeric = (key: string, fallback?: number): number | undefined => {
    const raw = form[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await action.run("create", () =>
      api.createTargetCost({
        name: form["name"] ?? "",
        contractReference: form["contractReference"] || undefined,
        isAlliance: participants.length > 0,
        currency: form["currency"] ?? "",
        baseTargetCost: numeric("baseTargetCost", 0) ?? 0,
        targetAdjustments: numeric("targetAdjustments", 0) ?? 0,
        actualDefinedCost: numeric("actualDefinedCost", 0) ?? 0,
        forecastDefinedCost: numeric("forecastDefinedCost"),
        feePercent: numeric("feePercent", 0) ?? 0,
        mechanism: form["mechanism"] ?? "banded_share",
        painCap: numeric("painCap"),
        gainCap: numeric("gainCap"),
        shareBands: bands.map((b) => ({
          fromPercent: Number(b.fromPercent) || 0,
          toPercent: b.toPercent.trim() === "" ? null : Number(b.toPercent),
          contractorSharePercent: Number(b.contractorSharePercent) || 0,
        })),
        participants: participants
          .filter((p) => p.name.trim() !== "")
          .map((p) => ({ name: p.name.trim(), sharePercent: Number(p.sharePercent) || 0 })),
      }),
    );
    if (res) {
      toast.success("Target-cost model created");
      onCreated(res.id);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="New target-cost model"
      description="Bands are percentages of the adjusted target, measured from zero variance outwards; the gain side is negative. Gaps and overlaps are refused, because they make the apportionment ambiguous."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="portfolio-target-create" loading={action.busy === "create"}>
            Create
          </Button>
        </div>
      }
    >
      <form id="portfolio-target-create" onSubmit={submit} className="space-y-4">
        {action.error ? (
          <Alert tone="danger" size="sm">
            {action.error}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required className="sm:col-span-2">
            <Input value={form["name"] ?? ""} onChange={(e) => set("name", e.target.value)} required />
          </Field>
          <Field label="Currency" required>
            <Input value={form["currency"] ?? ""} onChange={(e) => set("currency", e.target.value)} maxLength={3} required />
          </Field>
        </div>
        <Field label="Contract reference">
          <Input value={form["contractReference"] ?? ""} onChange={(e) => set("contractReference", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Base target" required>
            <Input
              type="number"
              value={form["baseTargetCost"] ?? ""}
              onChange={(e) => set("baseTargetCost", e.target.value)}
              min={0}
              step="0.01"
              required
            />
          </Field>
          <Field label="Agreed adjustments">
            <Input
              type="number"
              value={form["targetAdjustments"] ?? ""}
              onChange={(e) => set("targetAdjustments", e.target.value)}
              step="0.01"
            />
          </Field>
          <Field label="Actual defined cost">
            <Input
              type="number"
              value={form["actualDefinedCost"] ?? ""}
              onChange={(e) => set("actualDefinedCost", e.target.value)}
              min={0}
              step="0.01"
            />
          </Field>
          <Field label="Forecast defined cost">
            <Input
              type="number"
              value={form["forecastDefinedCost"] ?? ""}
              onChange={(e) => set("forecastDefinedCost", e.target.value)}
              min={0}
              step="0.01"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Fee %">
            <Input
              type="number"
              value={form["feePercent"] ?? ""}
              onChange={(e) => set("feePercent", e.target.value)}
              min={0}
              max={100}
              step="0.01"
            />
          </Field>
          <Field label="Mechanism">
            <Select value={form["mechanism"] ?? "banded_share"} onChange={(e) => set("mechanism", e.target.value)}>
              {PAIN_GAIN_MECHANISMS.map((m) => (
                <option key={m} value={m}>
                  {titleCase(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Pain cap" hint="Maximum contractor exposure">
            <Input type="number" value={form["painCap"] ?? ""} onChange={(e) => set("painCap", e.target.value)} min={0} step="0.01" />
          </Field>
          <Field label="Gain cap">
            <Input type="number" value={form["gainCap"] ?? ""} onChange={(e) => set("gainCap", e.target.value)} min={0} step="0.01" />
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">Share bands</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setBands((b) => [...b, { fromPercent: "", toPercent: "", contractorSharePercent: "" }])}
            >
              Add band
            </Button>
          </div>
          {bands.map((b, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-3">
              <Field label="From %">
                <Input
                  type="number"
                  value={b.fromPercent}
                  onChange={(e) =>
                    setBands((list) => list.map((x, j) => (i === j ? { ...x, fromPercent: e.target.value } : x)))
                  }
                  size="sm"
                  step="0.01"
                />
              </Field>
              <Field label="To % (blank = open)">
                <Input
                  type="number"
                  value={b.toPercent}
                  onChange={(e) =>
                    setBands((list) => list.map((x, j) => (i === j ? { ...x, toPercent: e.target.value } : x)))
                  }
                  size="sm"
                  step="0.01"
                />
              </Field>
              <Field label="Contractor %">
                <Input
                  type="number"
                  value={b.contractorSharePercent}
                  onChange={(e) =>
                    setBands((list) =>
                      list.map((x, j) => (i === j ? { ...x, contractorSharePercent: e.target.value } : x)),
                    )
                  }
                  size="sm"
                  min={0}
                  max={100}
                  step="0.01"
                />
              </Field>
            </div>
          ))}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-2xs font-semibold uppercase tracking-wide text-content-subtle">
              Alliance participants (optional)
            </span>
            <Button size="xs" variant="ghost" onClick={() => setParticipants((p) => [...p, { name: "", sharePercent: "" }])}>
              Add participant
            </Button>
          </div>
          {participants.map((p, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-3">
              <Field label="Name" className="sm:col-span-2">
                <Input
                  value={p.name}
                  onChange={(e) =>
                    setParticipants((list) => list.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))
                  }
                  size="sm"
                />
              </Field>
              <Field label="Share of contractor side %">
                <Input
                  type="number"
                  value={p.sharePercent}
                  onChange={(e) =>
                    setParticipants((list) => list.map((x, j) => (i === j ? { ...x, sharePercent: e.target.value } : x)))
                  }
                  size="sm"
                  min={0}
                  max={100}
                  step="0.01"
                />
              </Field>
            </div>
          ))}
        </div>
      </form>
    </Drawer>
  );
}
