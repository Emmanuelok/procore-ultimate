/**
 * SITE-ACCESS AND PAYROLL INGEST.
 *
 * Both streams arrive as files in practice — a turnstile export and a payroll
 * run — so both are pasted as CSV here rather than typed row by row. Two
 * things the forms make explicit, because they are the difference between a
 * control and an accusation:
 *
 *  • A PAYROLL RUN REFERENCE. Re-posting the same run REPLACES it. Without
 *    this the same file posted twice used to double every worker's claimed
 *    days and turn honest people into named overclaims.
 *  • UNKNOWN WORKERS ARE RETURNED, NOT DROPPED. A turnstile export naming a
 *    leaver must not lose the other 4,999 rows, and the rows it could not
 *    match are listed so somebody can fix the register.
 */
import { useState } from "react";
import { api } from "../../lib/api";
import { Alert, Button, Field, Input, Modal, Textarea } from "../../ui";

interface IngestResult {
  received: number;
  upserted?: number;
  replaced?: number;
  duplicatesCollapsed?: number;
  linkedTimecards?: number | { linked: number };
  unknown: Array<{ index: number; workerReference?: string; workerId?: string }>;
  note?: string | null;
}

/** Split a CSV body into trimmed cells, skipping blank lines. */
function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

const numberOrNull = (v: string | undefined): number | null =>
  v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

export function SiteAccessIngestModal({
  open,
  onClose,
  onDone,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
}) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const rows = parseCsv(csv);
      const records = rows
        .filter((r) => r[0]?.toLowerCase() !== "worker_reference")
        .map((r) => ({
          workerReference: r[0] ?? "",
          accessDate: r[1] ?? "",
          firstIn: r[2] || null,
          lastOut: r[3] || null,
          hoursOnSite: numberOrNull(r[4]),
        }));
      if (records.length === 0) throw new Error("No rows to send.");
      const res = await api.post<IngestResult>(`/api/v1/projects/${projectId}/site-access`, {
        records,
      });
      setResult(res);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The turnstile export could not be ingested.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ingest a turnstile export"
      description="This is the independent evidence stream the whole reconciliation rests on: a foreman's crew sheet is the claimant's own assertion, the gate log is not."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={csv.trim() === ""} onClick={submit}>
            Ingest
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <Alert tone={result.unknown.length > 0 ? "warning" : "success"} title="Ingested">
            <p>
              {result.received} row(s) received, {result.upserted ?? 0} written
              {result.duplicatesCollapsed
                ? `, ${result.duplicatesCollapsed} duplicate(s) collapsed`
                : ""}
              {typeof result.linkedTimecards === "object" && result.linkedTimecards
                ? `, ${result.linkedTimecards.linked} timecard(s) linked to their access record`
                : ""}
              .
            </p>
            {result.unknown.length > 0 ? (
              <p className="mt-1">
                {result.unknown.length} row(s) named a worker who is not on this project&apos;s
                register and were NOT written:{" "}
                {result.unknown
                  .slice(0, 8)
                  .map((u) => u.workerReference ?? u.workerId)
                  .join(", ")}
                . Enrol them, or correct the export — the rest of the file has landed.
              </p>
            ) : null}
          </Alert>
        ) : null}
        <Field
          label="CSV"
          hint="worker_reference, access_date (YYYY-MM-DD), first_in (HH:MM), last_out, hours_on_site. A header row is ignored."
          required
        >
          <Textarea
            rows={10}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"W-001,2026-03-02,07:12,17:04,9.2\nW-002,2026-03-02,07:05,16:58,9.1"}
          />
        </Field>
      </div>
    </Modal>
  );
}

export function PayrollIngestModal({
  open,
  onClose,
  onDone,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
}) {
  const [csv, setCsv] = useState("");
  const [runRef, setRunRef] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestResult | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const rows = parseCsv(csv);
      const entries = rows
        .filter((r) => r[0]?.toLowerCase() !== "worker_reference")
        .map((r) => {
          const gross = Number(r[3] ?? 0);
          const deductions = Number(r[4] ?? 0);
          return {
            workerReference: r[0] ?? "",
            periodStart: r[1] ?? "",
            periodEnd: r[2] ?? "",
            grossPay: gross,
            deductions,
            netPay: r[5] !== undefined && r[5] !== "" ? Number(r[5]) : gross - deductions,
            daysClaimed: Number(r[6] ?? 0),
            hoursClaimed: numberOrNull(r[7]),
            paidAt: r[8] || null,
            currency: currency.toUpperCase(),
          };
        });
      if (entries.length === 0) throw new Error("No rows to send.");
      const res = await api.post<IngestResult>(`/api/v1/projects/${projectId}/payroll`, {
        entries,
        ...(runRef.trim() ? { payrollRunRef: runRef.trim() } : {}),
      });
      setResult(res);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payroll file could not be ingested.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ingest a payroll run"
      description="A file that does not add up is rejected WHOLE: a partial ingest of a broken payroll file is worse than none, because the half that landed then reads as fact."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={csv.trim() === ""} onClick={submit}>
            Ingest
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <Alert tone={result.unknown.length > 0 ? "warning" : "success"} title="Ingested">
            <p>
              {result.received} row(s) received, {result.upserted ?? 0} written
              {result.replaced ? `, ${result.replaced} replaced` : ""}.
            </p>
            {result.note ? <p className="mt-1">{result.note}</p> : null}
            {result.unknown.length > 0 ? (
              <p className="mt-1">
                {result.unknown.length} row(s) named a worker who is not on this register and were
                NOT written.
              </p>
            ) : null}
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Payroll run reference"
            optional
            hint="Re-posting the same run replaces it. Leave blank for the employer's single run for the period."
          >
            <Input
              value={runRef}
              onChange={(e) => setRunRef(e.target.value)}
              placeholder="MAR-2026-MAIN"
            />
          </Field>
          <Field label="Currency">
            <Input
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            />
          </Field>
        </div>
        <Field
          label="CSV"
          hint="worker_reference, period_start, period_end, gross, deductions, net (blank = gross − deductions), days_claimed, hours_claimed, paid_at."
          required
        >
          <Textarea
            rows={10}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={"W-001,2026-03-01,2026-03-31,3120,0,3120,26,240,2026-04-05"}
          />
        </Field>
      </div>
    </Modal>
  );
}
