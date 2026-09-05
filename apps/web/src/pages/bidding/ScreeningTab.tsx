/**
 * FINANCIAL SCREENING — and the single-project limit.
 *
 * Most prequalification approvals are not binary. They are capped: "yes, up to
 * £2.5m on any one job". That cap is this module's real output, and a cap
 * produced as a bare number is worthless — the vendor cannot argue with it, the
 * buyer cannot defend it, and nobody can tell a year later whether the figures
 * behind it were audited accounts or something typed into a form.
 *
 * So the rule is STATED and every figure carries its basis: the three tests,
 * which one bound the answer, the haircuts applied and why, and — where
 * turnover is unknown — NO NUMBER AT ALL, with the reason.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  DescriptionList,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
} from "../../ui";
import type { DataColumns } from "../../ui";
import { IconFinance, IconPlus } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  CapacityNote,
  Figure,
  LoadError,
  LoadingBlock,
  PREQUAL_LABEL,
  PREQUAL_TONE,
  ReasonList,
  RecommendedLimitCard,
  RefusalPanel,
  isoDate,
  money,
  num,
  titleCase,
  useAction,
  useResource,
  useVendors,
} from "./biddingShared";
import type { CapacityCheck, FinancialList, FinancialRecord, VendorStanding } from "./types";

const BASE = "/api/v1/companies/current/prequalification";

const SOURCES = [
  "audited_accounts",
  "filed_accounts",
  "management_accounts",
  "credit_agency",
  "self_declared",
  "bank_reference",
] as const;

export default function ScreeningTab() {
  const [version, setVersion] = useState(0);
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [contractValue, setContractValue] = useState("");

  const financials = useResource<FinancialList>(
    `${BASE}/financials?page=1&pageSize=200${vendorId ? `&vendorId=${vendorId}` : ""}&_v=${version}`,
  );
  const standing = useResource<VendorStanding>(
    vendorId ? `${BASE}/vendors/${vendorId}?_v=${version}` : null,
  );
  const capacity = useResource<CapacityCheck>(
    vendorId && contractValue.trim() && Number.isFinite(Number(contractValue))
      ? `${BASE}/vendors/${vendorId}/capacity?contractValue=${encodeURIComponent(contractValue.trim())}`
      : null,
  );

  const vendorName = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vendors.data?.items ?? []) map.set(v.id, v.name);
    return map;
  }, [vendors.data]);

  const rows = financials.data?.items ?? [];
  const rule = financials.data?.rule;

  const columns: DataColumns<FinancialRecord> = useMemo(
    () => [
      {
        id: "vendor",
        header: "Vendor",
        accessor: (row) => vendorName.get(row.vendorId) ?? row.vendorId,
        type: "text",
        width: 200,
        sticky: "start",
      },
      { id: "year", header: "Year end", accessor: "financialYearEnd", type: "date", width: 130 },
      {
        id: "source",
        header: "Provenance",
        accessor: "source",
        type: "text",
        width: 180,
        groupable: true,
        cell: ({ row }) => (
          <div className="min-w-0">
            <Badge
              tone={
                row.source === "audited_accounts" || row.source === "filed_accounts"
                  ? "success"
                  : row.source === "self_declared"
                    ? "warning"
                    : "info"
              }
              size="xs"
              variant="subtle"
            >
              {titleCase(row.source)}
            </Badge>
            {row.verifiedAt ? (
              <p className="mt-0.5 text-2xs text-content-subtle">verified {isoDate(row.verifiedAt)}</p>
            ) : (
              <p className="mt-0.5 text-2xs text-content-subtle">not independently verified</p>
            )}
          </div>
        ),
      },
      {
        id: "turnover",
        header: "Turnover",
        accessor: "turnover",
        type: "currency",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.turnover === null ? (
            <span className="text-2xs italic text-content-subtle">not stated</span>
          ) : (
            <span className="tabular-nums">{money(row.turnover, row.currency)}</span>
          ),
      },
      {
        id: "netAssets",
        header: "Net assets",
        accessor: "netAssets",
        type: "currency",
        width: 150,
        align: "right",
        cell: ({ row }) =>
          row.netAssets === null ? (
            <span className="text-2xs italic text-content-subtle">not stated</span>
          ) : (
            <span className="tabular-nums">{money(row.netAssets, row.currency)}</span>
          ),
      },
      {
        id: "currentRatio",
        header: "Current ratio",
        accessor: (row) => row.ratios?.currentRatio.value ?? null,
        width: 190,
        align: "right",
        cell: ({ row }) => (
          <Figure
            figure={row.ratios?.currentRatio}
            className="block text-right"
            render={(v) => (
              <span
                className={
                  v < 1 ? "tabular-nums font-medium text-warning-fg" : "tabular-nums"
                }
              >
                {num(v, 2)}
              </span>
            )}
            showReasons={false}
          />
        ),
      },
      {
        id: "gearing",
        header: "Gearing",
        accessor: (row) => row.ratios?.gearingPercent.value ?? null,
        width: 170,
        align: "right",
        cell: ({ row }) => (
          <Figure
            figure={row.ratios?.gearingPercent}
            className="block text-right"
            render={(v) => (
              <span className={v > 100 ? "tabular-nums font-medium text-warning-fg" : "tabular-nums"}>
                {num(v, 1)}%
              </span>
            )}
            showReasons={false}
          />
        ),
      },
      {
        id: "limit",
        header: "Recommended single-project limit",
        accessor: (row) => row.recommendedLimit?.value ?? null,
        width: 280,
        cell: ({ row }) => (
          <div className="min-w-0 py-0.5">
            {row.recommendedLimit?.value == null ? (
              <>
                <span className="text-meta italic text-content-subtle">not available</span>
                <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-muted">
                  {row.recommendedLimit?.reasons[0] ??
                    "No screening could be derived from these figures."}
                </p>
              </>
            ) : (
              <>
                <span className="tabular-nums text-sm font-semibold">
                  {money(row.recommendedLimit.value, row.recommendedLimit.currency)}
                </span>
                <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-content-subtle">
                  {row.recommendedLimit.bindingTest === "hard_stop"
                    ? "Hard stop — see the basis."
                    : `Bound by the ${titleCase(row.recommendedLimit.bindingTest ?? "")} test.`}
                </p>
              </>
            )}
          </div>
        ),
      },
      {
        id: "flags",
        header: "Flags",
        accessor: (row) =>
          (row.isGoingConcernQualified ? 1 : 0) + (row.insolvencyEvents?.length ?? 0),
        width: 200,
        cell: ({ row }) => {
          const flags: string[] = [];
          if (row.isGoingConcernQualified) flags.push("going-concern qualified");
          if ((row.insolvencyEvents?.length ?? 0) > 0)
            flags.push(`${row.insolvencyEvents.length} insolvency event(s)`);
          if ((row.ccjCount ?? 0) > 0) flags.push(`${row.ccjCount} CCJ(s)`);
          return flags.length === 0 ? (
            <span className="text-2xs text-content-subtle">none</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {flags.map((f) => (
                <Badge key={f} tone="danger" size="xs" variant="subtle">
                  {f}
                </Badge>
              ))}
            </div>
          );
        },
      },
    ],
    [vendorName],
  );

  if (financials.loading && !financials.data) return <LoadingBlock rows={5} />;
  if (financials.error) return <LoadError message={financials.error} onRetry={financials.reload} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Vendor" className="min-w-[16rem]">
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              placeholder="Every vendor"
            >
              <option value="">Every vendor</option>
              {(vendors.data?.items ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          {vendorId ? (
            <Field
              label="Test a contract value"
              hint="Answers 'is this job inside what we approved them for'."
              className="w-48"
            >
              <Input
                type="number"
                inputMode="decimal"
                value={contractValue}
                onChange={(e) => setContractValue(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
        <Button icon={IconPlus} onClick={() => setAddOpen(true)}>
          Record financials
        </Button>
      </div>

      {vendorId && standing.data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card accent={PREQUAL_TONE[standing.data.state]}>
            <CardBody className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">
                  {standing.data.vendorName ?? vendorName.get(vendorId) ?? vendorId}
                </p>
                <Badge tone={PREQUAL_TONE[standing.data.state]} size="sm" dot>
                  {PREQUAL_LABEL[standing.data.state]}
                </Badge>
              </div>
              <p className="text-meta leading-relaxed text-content-muted">{standing.data.note}</p>
              <DescriptionList
                columns={2}
                size="sm"
                items={[
                  {
                    label: "Approved cap",
                    value:
                      standing.data.singleProjectLimit === null
                        ? "uncapped"
                        : money(standing.data.singleProjectLimit, standing.data.currency ?? "USD"),
                  },
                  { label: "Valid to", value: isoDate(standing.data.expiresAt) },
                  {
                    label: "Trade scope approved",
                    value:
                      standing.data.tradeScopeApproved.length === 0
                        ? "not restricted"
                        : standing.data.tradeScopeApproved.join(", "),
                    span: 2,
                  },
                ]}
              />
              {capacity.data ? (
                <div className="pt-1">
                  <CapacityNote check={capacity.data.capacity} />
                  <div className="mt-2 text-meta">
                    <span className="text-content-subtle">Contract against turnover: </span>
                    <Figure
                      figure={capacity.data.contractToTurnover}
                      render={(v) => <span className="tabular-nums">{num(v, 1)}%</span>}
                    />
                  </div>
                </div>
              ) : null}
            </CardBody>
          </Card>
          <RecommendedLimitCard limit={standing.data.recommendedLimit} />
        </div>
      ) : null}

      {rule ? (
        <Card variant="flat">
          <CardBody>
            <p className="text-sm font-semibold">The rule, stated</p>
            <p className="mt-1 text-meta leading-relaxed text-content-muted">
              The recommendation is the LOWEST applicable test, and the response names which test
              bound it. A contractor carrying one job worth more than {num(rule.turnoverShare * 100, 0)}% of
              its annual turnover has its whole year riding on that job; a loss on a contract is
              absorbed by the balance sheet or it is absorbed by you; and a step change of more than{" "}
              {num(rule.trackRecordMultiple, 0)}× the biggest job they have ever delivered is a
              capability risk, not a commercial one.
            </p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-meta sm:grid-cols-3">
              <RuleRow label="Turnover share" value={`${num(rule.turnoverShare * 100, 0)}%`} />
              <RuleRow label="Net assets multiple" value={`${num(rule.netAssetsMultiple, 0)}×`} />
              <RuleRow label="Track record multiple" value={`${num(rule.trackRecordMultiple, 0)}×`} />
              <RuleRow
                label="Liquidity haircut"
                value={`current ratio < ${num(rule.minCurrentRatio, 1)} ⇒ ×${rule.lowLiquidityFactor}`}
              />
              <RuleRow
                label="Gearing haircut"
                value={`debt > ${num(rule.maxGearingPercent, 0)}% ⇒ ×${rule.highGearingFactor}`}
              />
              <RuleRow
                label="Provenance haircut"
                value={`unverified figures ⇒ ×${rule.unverifiedSourceFactor}`}
              />
            </dl>
            <p className="mt-2 text-2xs text-content-subtle">
              A going-concern qualification or an insolvency event is not a score: it sets the
              recommendation to zero and says so. And where turnover is unknown there is no number
              at all — never a default, never a zero that reads like a decision.
            </p>
          </CardBody>
        </Card>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={IconFinance}
          title={
            vendorId ? "No accounts on record for this vendor" : "No financial figures on record"
          }
          hint="Without figures there is no screening, and without screening there is no recommended limit — the platform will not invent one. Record a set of accounts, and say where they came from: audited accounts and a number typed into a form are not the same evidence, and the recommendation is cut where it cannot be verified."
          action={
            <Button icon={IconPlus} onClick={() => setAddOpen(true)}>
              Record financials
            </Button>
          }
        />
      ) : (
        <DataTable<FinancialRecord>
          tableId="bidding.financials"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          height={480}
          rowHeight={62}
          stickyHeader
          filterRow
          searchPlaceholder="Search screenings…"
          exportFileName="financial-screening"
          rowTone={(row) =>
            row.isGoingConcernQualified || (row.insolvencyEvents?.length ?? 0) > 0
              ? "danger"
              : undefined
          }
          empty={{ title: "Nothing matches", description: "The filters exclude every record." }}
        />
      )}

      <AddFinancialsModal
        open={addOpen}
        defaultVendorId={vendorId}
        onClose={() => setAddOpen(false)}
        onCreated={() => setVersion((n) => n + 1)}
        onDone={() => {
          setAddOpen(false);
          setVersion((n) => n + 1);
        }}
      />
    </div>
  );
}

function RuleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-content-subtle">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/* ================================================================== */
/* Record a set of accounts                                            */
/* ================================================================== */

function AddFinancialsModal({
  open,
  defaultVendorId,
  onClose,
  onCreated,
  onDone,
}: {
  open: boolean;
  defaultVendorId: string;
  onClose: () => void;
  /** Fired on every successful write — the register always shows what was written. */
  onCreated: () => void;
  onDone: () => void;
}) {
  const vendors = useVendors();
  const action = useAction();
  const [vendorId, setVendorId] = useState(defaultVendorId);
  const [yearEnd, setYearEnd] = useState("");
  const [source, setSource] = useState<string>("audited_accounts");
  const [currency, setCurrency] = useState("USD");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [goingConcern, setGoingConcern] = useState(false);
  const [result, setResult] = useState<FinancialRecord | null>(null);

  const set = (key: string, value: string) => setFields((prev) => ({ ...prev, [key]: value }));
  const numeric = (key: string): number | undefined => {
    const raw = fields[key];
    if (!raw || !raw.trim()) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  async function submit() {
    const body: Record<string, unknown> = {
      vendorId,
      financialYearEnd: yearEnd,
      source,
      currency: currency.trim().toUpperCase(),
      isGoingConcernQualified: goingConcern,
    };
    for (const key of [
      "turnover",
      "operatingProfit",
      "profitBeforeTax",
      "netAssets",
      "currentAssets",
      "currentLiabilities",
      "cashAtBank",
      "totalDebt",
      "inventory",
      "largestContractValue",
      "orderBookValue",
    ]) {
      const v = numeric(key);
      if (v !== undefined) body[key] = v;
    }
    const created = await action.run("financials", () =>
      api.post<FinancialRecord>(`${BASE}/financials`, body),
    );
    if (created) {
      /*
       * A financial record always produces a result panel (the derived limit
       * and its basis), so `onDone` was never reached and the register behind
       * the modal never refreshed. The write is done; the list must show it.
       */
      onCreated();
      setResult(created);
    }
  }

  const MONEY_FIELDS: Array<[string, string, string]> = [
    ["turnover", "Turnover", "Without it there is no limit at all — the first test cannot run."],
    ["netAssets", "Net assets", "What absorbs a loss on the contract."],
    ["currentAssets", "Current assets", "With current liabilities, gives the current ratio."],
    ["currentLiabilities", "Current liabilities", ""],
    ["cashAtBank", "Cash at bank", ""],
    ["totalDebt", "Total debt", "Against net assets, gives gearing."],
    ["inventory", "Stock / WIP", "Needed for the acid test, which is otherwise refused."],
    ["operatingProfit", "Operating profit", ""],
    ["profitBeforeTax", "Profit before tax", ""],
    ["largestContractValue", "Largest contract delivered", "The track-record test."],
    ["orderBookValue", "Order book", ""],
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Record a set of accounts"
      description="Where they came from matters as much as what they say."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void submit()}
            loading={action.busy === "financials"}
            disabled={!vendorId || !yearEnd}
          >
            Record and screen
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <RefusalPanel refusal={action.refusal} onDismiss={action.clear} />

        {result ? (
          <div className="space-y-3">
            <Alert
              tone="success"
              title="Recorded — here is what the rule made of it"
              actions={
                <Button size="sm" variant="secondary" onClick={onDone}>
                  Done
                </Button>
              }
            >
              The screening below is derived, not stored as an opinion: it is re-derived from these
              figures every time it is read.
            </Alert>
            <RecommendedLimitCard limit={result.recommendedLimit ?? null} />
            {result.ratios ? (
              <Card>
                <CardBody>
                  <p className="text-label uppercase text-content-subtle">Derived ratios</p>
                  <dl className="mt-1.5 grid gap-x-6 gap-y-1.5 text-meta sm:grid-cols-2">
                    {(
                      [
                        ["Working capital", result.ratios.workingCapital, 0],
                        ["Current ratio", result.ratios.currentRatio, 2],
                        ["Acid test", result.ratios.acidTestRatio, 2],
                        ["Gearing %", result.ratios.gearingPercent, 1],
                        ["Profit margin %", result.ratios.profitMarginPercent, 1],
                        ["Return on capital %", result.ratios.returnOnCapitalPercent, 1],
                      ] as const
                    ).map(([label, figure, dp]) => (
                      <div key={label} className="flex justify-between gap-3">
                        <dt className="text-content-subtle">{label}</dt>
                        <dd className="text-right">
                          <Figure
                            figure={figure}
                            render={(v) => <span className="tabular-nums">{num(v, dp)}</span>}
                            showReasons={false}
                          />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <ReasonList
                    reasons={[
                      ...new Set(
                        [
                          result.ratios.workingCapital,
                          result.ratios.currentRatio,
                          result.ratios.acidTestRatio,
                          result.ratios.gearingPercent,
                          result.ratios.profitMarginPercent,
                          result.ratios.returnOnCapitalPercent,
                        ].flatMap((f) => (f.value === null ? f.reasons : [])),
                      ),
                    ]}
                    heading="Why some ratios could not be formed"
                    className="mt-2"
                  />
                </CardBody>
              </Card>
            ) : null}
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Vendor" required>
                <Select
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  placeholder="Choose a vendor"
                >
                  {(vendors.data?.items ?? []).map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Financial year end" required>
                <Input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
              </Field>
              <Field
                label="Provenance"
                required
                hint="Self-declared figures carry a haircut. Audited accounts and a number typed into a form are not the same evidence."
              >
                <Select value={source} onChange={(e) => setSource(e.target.value)}>
                  {SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {titleCase(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency">
                <Input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  maxLength={8}
                  className="w-32"
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {MONEY_FIELDS.map(([key, label, hint]) => (
                <Field key={key} label={label} hint={hint || undefined} optional>
                  <Input
                    type="number"
                    inputMode="decimal"
                    value={fields[key] ?? ""}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </Field>
              ))}
            </div>

            <label className="flex items-start gap-2 text-meta">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={goingConcern}
                onChange={(e) => setGoingConcern(e.target.checked)}
              />
              <span>
                The auditor qualified the going-concern basis. This is not a score — it sets the
                recommended limit to zero and says so.
              </span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
