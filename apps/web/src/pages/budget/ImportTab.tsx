/**
 * BULK LINE IMPORT.
 *
 * The API validates the WHOLE file before it writes a single row, because a
 * half-imported budget is worse than a refused one: the caller is told the
 * import failed while the budget quietly holds half of it. This screen is
 * built around that guarantee — every import runs as a DRY RUN first, and the
 * commit button does not appear until the dry run comes back clean.
 *
 * Two details worth keeping:
 *
 *  · UNKNOWN COLUMNS ARE REPORTED, NOT IGNORED. A silently dropped
 *    `original_budget` column is a budget that is quietly zero, so anything
 *    the parser did not recognise is named here before anything is written.
 *  · EVERY REJECTED ROW KEEPS ITS ROW NUMBER AND THE SERVER'S OWN MESSAGE.
 *    "Cost code 03-3100 does not exist on this project or in the company
 *    standard list" is a sentence somebody can act on; "invalid file" is not.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorAlert,
  Field,
  Select,
  Table,
  Td,
  Th,
  Tr,
  cx,
  useConfirm,
} from "../../ui";
import { IconDownload, IconImport, IconWarning } from "../../ui/icons";
import { FileDropzone } from "../../ui/inputs";
import type { FileDropzoneHandle } from "../../ui/inputs";
import { api } from "../../lib/api";
import {
  SectionHeading,
  count,
  errorIssues,
  errorMessage,
  labelize,
  money,
  type BudgetDetail,
  type ImportDryRun,
  type ImportIssue,
  type ImportResult,
} from "./budgetShared";

/** The header aliases the API's CSV reader accepts, in its own order. */
const ACCEPTED_COLUMNS: Array<{ field: string; aliases: string[]; required?: boolean }> = [
  { field: "Cost code", aliases: ["cost_code", "costcode", "code"], required: true },
  { field: "Description", aliases: ["description"], required: true },
  { field: "Cost type", aliases: ["cost_type", "costtype"] },
  { field: "Unit", aliases: ["unit"] },
  { field: "Quantity", aliases: ["quantity", "qty"] },
  { field: "Unit rate", aliases: ["unit_rate", "unitrate", "rate"] },
  { field: "Original budget", aliases: ["original_budget", "originalbudget", "amount"] },
  { field: "Line kind", aliases: ["line_kind", "linekind"] },
  { field: "WBS path", aliases: ["wbs_path", "wbspath"] },
  { field: "Sub job", aliases: ["sub_job", "subjob"] },
  { field: "Notes", aliases: ["notes"] },
  { field: "Sort order", aliases: ["sort_order", "sortorder"] },
];

const TEMPLATE_CSV = [
  "cost_code,cost_type,description,unit,quantity,unit_rate,original_budget,line_kind,sub_job,notes",
  "03-3000,material,Concrete — ready mix,m3,1200,145,174000,standard,,",
  "03-3000,labour,Concrete — placing crew,,,,96000,standard,,",
  "01-9000,other,Construction contingency,,,,250000,contingency,,Drawn only by an approved change",
].join("\n");

export interface ImportTabProps {
  budget: BudgetDetail;
  currency: string;
  onChanged: () => void;
}

export default function ImportTab({ budget, currency, onChanged }: ImportTabProps) {
  const { confirm, dialog } = useConfirm();
  const dropzone = useRef<FileDropzoneHandle>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "upsert">("create");
  const [dryRun, setDryRun] = useState<ImportDryRun | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [committing, setCommitting] = useState(false);

  const frozen = !budget.planEditable;

  const reset = useCallback(() => {
    setDryRun(null);
    setResult(null);
    setIssues([]);
    setError(null);
  }, []);

  const validate = useCallback(
    async (text: string, nextMode: "create" | "upsert") => {
      setChecking(true);
      reset();
      try {
        const response = await api.post<ImportDryRun>(
          `/api/v1/budgets/${budget.id}/lines/import`,
          { csv: text, dryRun: true, mode: nextMode },
        );
        setDryRun(response);
        setIssues(response.issues);
      } catch (err) {
        setError(errorMessage(err, "The file could not be read"));
        setIssues(errorIssues(err));
      } finally {
        setChecking(false);
      }
    },
    [budget.id, reset],
  );

  const onAccepted = useCallback(
    (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setFileName(file.name);
      file
        .text()
        .then((text) => {
          setCsv(text);
          void validate(text, mode);
        })
        .catch(() => setError("That file could not be read from disk."));
    },
    [mode, validate],
  );

  async function commit() {
    if (!csv) return;
    if (mode === "upsert") {
      // Upsert overwrites the amounts on lines that already exist. That is a
      // destructive write to figures somebody may already have reported on, so
      // it is named before it happens.
      const ok = await confirm({
        title: "Overwrite existing lines?",
        description:
          "Upsert mode replaces the amounts, description and unit basis on any line whose cost code and cost type already exist on this budget. Those figures may already have been reported against.",
        confirmLabel: "Overwrite and import",
        destructive: true,
      });
      if (!ok) return;
    }
    setCommitting(true);
    setError(null);
    setIssues([]);
    try {
      const response = await api.post<ImportResult>(
        `/api/v1/budgets/${budget.id}/lines/import`,
        { csv, dryRun: false, mode },
      );
      setResult(response);
      setDryRun(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err, "Nothing was written — the import was refused"));
      setIssues(errorIssues(err));
    } finally {
      setCommitting(false);
    }
  }

  function clearFile() {
    dropzone.current?.clear();
    setFileName(null);
    setCsv(null);
    reset();
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${budget.reference}-import-template.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const ready = dryRun !== null && issues.length === 0 && dryRun.readyRows > 0;

  const summary = useMemo(() => {
    if (!dryRun) return null;
    return [
      { label: "Rows parsed", value: count(dryRun.parsedRows) },
      { label: "Rows ready to write", value: count(dryRun.readyRows) },
      { label: "Rows rejected", value: count(dryRun.issues.length) },
      { label: "Original budget in the file", value: money(dryRun.totalOriginalBudget, currency) },
    ];
  }, [dryRun, currency]);

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Import budget lines"
        hint="Validated in full before a single row is written. Nothing is committed until the dry run is clean."
        actions={
          <Button variant="secondary" leadingIcon={IconDownload} onClick={downloadTemplate}>
            Download a template
          </Button>
        }
      />

      {frozen ? (
        <Alert tone="warning" title="Plan amounts are frozen on this budget">
          {budget.lockedAt
            ? `${budget.reference} is locked, so no new line can be imported. Money moves through an approved budget change from here.`
            : `${budget.reference} has been captured as at ${budget.lastSnapshot?.asOfDate ?? "a period close"}, so the line set is frozen to keep that capture true.`}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardBody>
            <FileDropzone
              ref={dropzone}
              accept=".csv,text/csv"
              multiple={false}
              maxFiles={1}
              maxSize={4 * 1024 * 1024}
              autoUpload={false}
              showPreviews={false}
              disabled={frozen}
              label="Drop a CSV of budget lines"
              hint="Up to 2,000 rows and 4 MB. Headers are matched case-insensitively, in snake_case or camelCase."
              onAccepted={onAccepted}
              onRejected={(rejections) => {
                const first = rejections[0];
                setError(first ? `${first.file.name}: ${first.reason}` : "That file was rejected.");
              }}
              aria-label="Budget line CSV"
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Field label="If a WBS coordinate already exists" className="min-w-64">
                <Select
                  value={mode}
                  onChange={(event) => {
                    const next = event.target.value as "create" | "upsert";
                    setMode(next);
                    if (csv) void validate(csv, next);
                  }}
                  disabled={frozen}
                >
                  <option value="create">Refuse the whole import</option>
                  <option value="upsert">Update the existing line's amounts</option>
                </Select>
              </Field>
              {fileName ? (
                <Button variant="ghost" size="sm" onClick={clearFile}>
                  Clear {fileName}
                </Button>
              ) : null}
            </div>
          </CardBody>
        </Card>

        <Card variant="sunken">
          <CardBody>
            <h3 className="text-label uppercase text-content-subtle">Columns the reader accepts</h3>
            <ul className="mt-2 space-y-1">
              {ACCEPTED_COLUMNS.map((column) => (
                <li key={column.field} className="flex items-baseline justify-between gap-3 text-meta">
                  <span className="text-content">
                    {column.field}
                    {column.required ? (
                      <Badge tone="danger" size="xs" className="ml-1.5">
                        required
                      </Badge>
                    ) : null}
                  </span>
                  <span className="font-mono text-code text-content-subtle">
                    {column.aliases.join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-meta text-content-muted">
              A measured line's budget is its extension: give quantity and unit rate, or give an
              amount, but an amount that disagrees with quantity × unit rate is refused rather than
              silently overwritten.
            </p>
          </CardBody>
        </Card>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      {checking ? (
        <div className="skeleton h-32 rounded-lg" aria-hidden="true" />
      ) : null}

      {result ? (
        <Alert
          tone="success"
          title={`Imported ${count(result.created)} new line${result.created === 1 ? "" : "s"}${
            result.updated > 0 ? ` and updated ${count(result.updated)}` : ""
          }`}
          onDismiss={() => setResult(null)}
        >
          <p>
            {count(result.parsedRows)} row{result.parsedRows === 1 ? "" : "s"} were read from{" "}
            {fileName ?? "the file"}.
          </p>
          {result.unknownColumns.length > 0 ? (
            <p className="mt-1">
              Columns the reader did not recognise and did not import:{" "}
              <span className="font-mono text-code">{result.unknownColumns.join(", ")}</span>
            </p>
          ) : null}
        </Alert>
      ) : null}

      {dryRun ? (
        <section>
          <SectionHeading
            title="Dry run"
            hint="Nothing has been written. This is exactly what the import would do."
            actions={
              <Button
                leadingIcon={IconImport}
                onClick={() => void commit()}
                loading={committing}
                disabled={!ready || frozen}
                title={
                  ready
                    ? "Write these lines to the budget"
                    : "Every row must validate before anything is written"
                }
              >
                Import {count(dryRun.readyRows)} line{dryRun.readyRows === 1 ? "" : "s"}
              </Button>
            }
          />

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summary?.map((entry) => (
              <Card key={entry.label} variant="sunken">
                <CardBody className="py-3">
                  <p className="text-label uppercase text-content-subtle">{entry.label}</p>
                  <p className="text-body font-semibold tabular-nums text-content">{entry.value}</p>
                </CardBody>
              </Card>
            ))}
          </div>

          {dryRun.unknownColumns.length > 0 ? (
            <Alert
              tone="warning"
              className="mt-3"
              icon={IconWarning}
              title={`${dryRun.unknownColumns.length} column${
                dryRun.unknownColumns.length === 1 ? "" : "s"
              } will not be imported`}
            >
              <p>
                <span className="font-mono text-code">{dryRun.unknownColumns.join(", ")}</span> —
                reported rather than ignored, because a silently dropped budget column is a budget
                that is quietly zero.
              </p>
            </Alert>
          ) : null}

          {issues.length > 0 ? (
            <IssueTable issues={issues} className="mt-3" />
          ) : (
            <Alert tone="success" size="sm" className="mt-3" title="Every row validates">
              All {count(dryRun.readyRows)} rows resolve to a real cost code on this project and
              parse cleanly. The import will be written in one transaction.
            </Alert>
          )}

          {dryRun.preview.length > 0 ? (
            <div className="mt-3">
              <h3 className="mb-2 text-label uppercase text-content-subtle">
                First {count(dryRun.preview.length)} rows as they would be written
              </h3>
              <Table dense>
                <thead>
                  <tr>
                    <Th numeric>Row</Th>
                    <Th>Cost code</Th>
                    <Th>Cost type</Th>
                    <Th>Description</Th>
                    <Th numeric>Original budget</Th>
                  </tr>
                </thead>
                <tbody>
                  {dryRun.preview.map((row) => (
                    <Tr key={row.row}>
                      <Td numeric muted>
                        {row.row}
                      </Td>
                      <Td className="font-mono text-code">{row.costCode}</Td>
                      <Td muted>{labelize(row.costType)}</Td>
                      <Td truncate>{row.description}</Td>
                      <Td numeric>{money(row.originalBudget, currency)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
        </section>
      ) : issues.length > 0 ? (
        <IssueTable issues={issues} />
      ) : !csv && !result ? (
        <EmptyState
          icon={IconImport}
          title="No file yet"
          hint="Drop a CSV above and every row is checked against this project's cost-code list before anything is written."
        />
      ) : null}

      {dialog}
    </div>
  );
}

function IssueTable({ issues, className }: { issues: readonly ImportIssue[]; className?: string }) {
  return (
    <section className={cx(className)}>
      <h3 className="mb-2 text-label uppercase text-danger-fg">
        {count(issues.length)} row{issues.length === 1 ? "" : "s"} rejected — nothing was written
      </h3>
      <Table dense>
        <thead>
          <tr>
            <Th numeric>Row</Th>
            <Th>Field</Th>
            <Th>Why the platform refused it</Th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <Tr key={`${issue.row}-${issue.field ?? "row"}-${index}`}>
              <Td numeric muted>
                {issue.row}
              </Td>
              <Td className="font-mono text-code">{issue.field ?? "—"}</Td>
              <Td>{issue.message}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </section>
  );
}
