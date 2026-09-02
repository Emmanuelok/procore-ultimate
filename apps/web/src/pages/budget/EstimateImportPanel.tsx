/**
 * ESTIMATE → BUDGET (spec #480) — build the budget from the priced document
 * that was actually awarded, rather than from a figure retyped out of it.
 *
 * The panel is deliberately honest about what it will NOT carry:
 *
 *  · Scope the bidder EXCLUDED from their price is listed and skipped. A
 *    price the bidder said is not in their number is not a budget.
 *  · ALTERNATES are options, not the base bid, so they are skipped unless
 *    the user asks for them.
 *  · When the priced lines that land do not sum to the award amount, the
 *    difference is stated with its reason — it is never quietly absorbed.
 *
 * As with the CSV import, the dry run runs first and the commit button does
 * not appear until it comes back clean, because a half-built budget is worse
 * than a refused one.
 */
import { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  EmptyState,
  ErrorAlert,
  Field,
  Select,
  Table,
  Td,
  Th,
  Tr,
  useConfirm,
} from "../../ui";
import { IconContract, IconWarning } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  SectionHeading,
  count,
  errorIssues,
  errorMessage,
  labelize,
  money,
  useResource,
  type BudgetDetail,
  type ImportIssue,
} from "./budgetShared";

export interface EstimateSource {
  packageId: string;
  packageReference: string;
  packageTitle: string;
  packageStatus: string;
  awardId: string;
  awardReference: string;
  awardStatus: string;
  awardAmount: number;
  currency: string;
  vendorId: string;
  submissionId: string;
  awardedAt: string | null;
  importable: boolean;
  reason: string | null;
}

interface SourcesResponse {
  budgetId: string;
  currency: string;
  items: EstimateSource[];
  reasons: string[];
}

interface SkippedLine {
  description: string;
  amount: number | null;
  reason: string;
}

interface PreviewRow {
  row: number;
  costCode: string;
  costType: string;
  description: string;
  originalBudget: number;
  sourceLines: number;
}

interface EstimateImport {
  dryRun: boolean;
  budgetId: string;
  source: {
    packageReference: string;
    packageTitle: string;
    awardReference: string;
    awardStatus: string;
    awardAmount: number;
    currency: string;
    submissionLines: number;
  };
  readyLines?: number;
  created?: number;
  updated?: number;
  issues?: ImportIssue[];
  skipped: SkippedLine[];
  preview?: PreviewRow[];
  totalOriginalBudget: number;
  reconciliation: { ok: boolean; reasons: string[] };
}

export default function EstimateImportPanel({
  budget,
  currency,
  onChanged,
}: {
  budget: BudgetDetail;
  currency: string;
  onChanged: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [packageId, setPackageId] = useState("");
  const [mode, setMode] = useState<"create" | "upsert">("create");
  const [includeAlternates, setIncludeAlternates] = useState(false);
  const [dry, setDry] = useState<EstimateImport | null>(null);
  const [result, setResult] = useState<EstimateImport | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);

  const sources = useResource<SourcesResponse>(
    (signal) => api.get<SourcesResponse>(`/api/v1/budgets/${budget.id}/estimate-sources`, { signal }),
    [budget.id],
  );
  const chosen = useMemo(
    () => sources.data?.items.find((s) => s.packageId === packageId) ?? null,
    [sources.data, packageId],
  );
  const frozen = !budget.planEditable;

  const check = useCallback(
    async (id: string, nextMode: "create" | "upsert", alternates: boolean) => {
      if (!id) return;
      setChecking(true);
      setDry(null);
      setResult(null);
      setIssues([]);
      setError(null);
      try {
        const response = await api.post<EstimateImport>(
          `/api/v1/budgets/${budget.id}/lines/from-estimate`,
          { packageId: id, dryRun: true, mode: nextMode, includeAlternates: alternates },
        );
        setDry(response);
        setIssues(response.issues ?? []);
      } catch (err) {
        setError(errorMessage(err, "That award could not be read"));
        setIssues(errorIssues(err));
      } finally {
        setChecking(false);
      }
    },
    [budget.id],
  );

  async function commit() {
    if (!packageId) return;
    if (mode === "upsert") {
      const ok = await confirm({
        title: "Overwrite existing lines?",
        description:
          "Upsert replaces the amounts, description and unit basis on any line whose cost code and cost type already exist on this budget. Those figures may already have been reported against.",
        confirmLabel: "Overwrite and import",
        destructive: true,
      });
      if (!ok) return;
    }
    setCommitting(true);
    setError(null);
    setIssues([]);
    try {
      const response = await api.post<EstimateImport>(
        `/api/v1/budgets/${budget.id}/lines/from-estimate`,
        { packageId, dryRun: false, mode, includeAlternates },
      );
      setResult(response);
      setDry(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Nothing was written — the import was refused"));
      setIssues(errorIssues(err));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardBody className="space-y-4">
        <SectionHeading
          title="Build from an awarded bid package"
          hint="The awarded submission is the estimate of record: its priced lines already carry cost codes, so the budget inherits the document that will be contracted."
        />

        <ErrorAlert message={sources.error} onRetry={sources.reload} />

        {sources.loading ? (
          <p className="text-body-sm text-content-muted">Loading awards…</p>
        ) : (sources.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            icon={IconContract}
            title="No approved award on this project"
            hint={
              sources.data?.reasons[0] ??
              "A budget is built from the priced submission that was awarded. Approve an award on a bid package first."
            }
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Awarded package" hint="Only packages whose award has been approved appear here.">
                <Select
                  value={packageId}
                  disabled={frozen}
                  onChange={(e) => {
                    setPackageId(e.target.value);
                    void check(e.target.value, mode, includeAlternates);
                  }}
                >
                  <option value="">Choose an award…</option>
                  {sources.data?.items.map((s) => (
                    <option key={s.awardId} value={s.packageId}>
                      {s.packageReference} · {s.packageTitle} — {s.awardReference} (
                      {money(s.awardAmount, s.currency)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Mode" hint="Upsert updates a line whose cost code and cost type already exist.">
                <Select
                  value={mode}
                  disabled={frozen}
                  onChange={(e) => {
                    const next = e.target.value as "create" | "upsert";
                    setMode(next);
                    void check(packageId, next, includeAlternates);
                  }}
                >
                  <option value="create">Create new lines only</option>
                  <option value="upsert">Create or update</option>
                </Select>
              </Field>
              <Field label="Alternates" hint="An alternate is a priced option, not the base bid.">
                <Checkbox
                  checked={includeAlternates}
                  disabled={frozen}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setIncludeAlternates(next);
                    void check(packageId, mode, next);
                  }}
                  label="Include the bidder's alternates"
                />
              </Field>
            </div>

            {chosen && !chosen.importable ? (
              <Alert tone="warning" title="This award cannot fund this budget">
                {chosen.reason ?? "The award is priced in another currency."}
              </Alert>
            ) : null}

            {frozen ? (
              <Alert tone="info" title="The plan is closed">
                A captured snapshot or a locked budget freezes the plan. Money moves through an
                approved budget change from here on.
              </Alert>
            ) : null}

            <ErrorAlert message={error} />

            {issues.length > 0 ? <IssueList issues={issues} /> : null}

            {checking ? <p className="text-body-sm text-content-muted">Checking the award…</p> : null}

            {dry ? (
              <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{count(dry.source.submissionLines)} priced lines on the submission</Badge>
                  <Badge tone={(dry.readyLines ?? 0) > 0 ? "success" : "warning"}>
                    {count(dry.readyLines ?? 0)} budget line{(dry.readyLines ?? 0) === 1 ? "" : "s"} ready
                  </Badge>
                  <Badge tone="neutral">{money(dry.totalOriginalBudget, currency)} total</Badge>
                  {dry.skipped.length > 0 ? (
                    <Badge tone="warning">{count(dry.skipped.length)} skipped</Badge>
                  ) : null}
                </div>

                {!dry.reconciliation.ok ? (
                  <Alert tone="warning" icon={IconWarning} title="This does not equal the award">
                    {dry.reconciliation.reasons.join(" ")}
                  </Alert>
                ) : null}

                {dry.skipped.length > 0 ? (
                  <div className="overflow-x-auto">
                    <Table dense>
                      <thead>
                        <tr>
                          <Th>Left out</Th>
                          <Th numeric>Priced at</Th>
                          <Th>Why</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {dry.skipped.map((s, i) => (
                          <Tr key={`${s.description}-${i}`}>
                            <Td truncate>{s.description}</Td>
                            <Td numeric muted>{s.amount === null ? "—" : money(s.amount, currency)}</Td>
                            <Td muted>{s.reason}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                ) : null}

                {(dry.preview?.length ?? 0) > 0 ? (
                  <div className="overflow-x-auto">
                    <Table dense>
                      <thead>
                        <tr>
                          <Th>Cost code</Th>
                          <Th>Cost type</Th>
                          <Th>Description</Th>
                          <Th numeric>Original budget</Th>
                          <Th numeric>From</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {dry.preview?.map((row) => (
                          <Tr key={row.row}>
                            <Td className="font-mono text-code">{row.costCode}</Td>
                            <Td muted>{labelize(row.costType)}</Td>
                            <Td truncate>{row.description}</Td>
                            <Td numeric>{money(row.originalBudget, currency)}</Td>
                            <Td numeric muted>
                              {count(row.sourceLines)} line{row.sourceLines === 1 ? "" : "s"}
                            </Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                ) : null}

                <Button
                  onClick={commit}
                  loading={committing}
                  disabled={
                    frozen ||
                    committing ||
                    (dry.issues?.length ?? 0) > 0 ||
                    (dry.readyLines ?? 0) === 0 ||
                    (chosen !== null && !chosen.importable)
                  }
                >
                  Write {count(dry.readyLines ?? 0)} line{(dry.readyLines ?? 0) === 1 ? "" : "s"} to the budget
                </Button>
              </section>
            ) : null}

            {result ? (
              <Alert tone="success" title={`${result.source.awardReference} landed on the budget`}>
                {count(result.created ?? 0)} line{(result.created ?? 0) === 1 ? "" : "s"} created,{" "}
                {count(result.updated ?? 0)} updated, {money(result.totalOriginalBudget, currency)} of
                original budget. Every line carries the package, award and submission it came from.
                {result.reconciliation.ok ? "" : ` ${result.reconciliation.reasons.join(" ")}`}
              </Alert>
            ) : null}
          </>
        )}
        {dialog}
      </CardBody>
    </Card>
  );
}

function IssueList({ issues }: { issues: readonly ImportIssue[] }) {
  return (
    <section>
      <h3 className="mb-2 text-label uppercase text-danger-fg">
        {count(issues.length)} award line{issues.length === 1 ? "" : "s"} cannot land — nothing was written
      </h3>
      <Table dense>
        <thead>
          <tr>
            <Th numeric>Line</Th>
            <Th>Field</Th>
            <Th>Why the platform refused it</Th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <Tr key={`${issue.row}-${issue.field ?? "row"}-${index}`}>
              <Td numeric muted>{issue.row}</Td>
              <Td className="font-mono text-code">{issue.field ?? "—"}</Td>
              <Td>{issue.message}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
