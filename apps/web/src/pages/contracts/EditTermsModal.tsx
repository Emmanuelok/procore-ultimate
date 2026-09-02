/**
 * Edit the contract's terms.
 *
 * The API has always had PATCH; nothing in the web app called it, so a typo in
 * an LD rate — or a Particular Condition agreed after execution — could only be
 * fixed by deleting and recreating the contract, which is not possible either.
 * Form and NEC option stay locked once the contract is executed, because they
 * decide which clause library the time-bar engine runs.
 */
import { useEffect, useState } from "react";
import { api, ApiClientError } from "../../lib/api";
import { Button, ErrorAlert, Field, Input, Modal, Select } from "../../ui";
import type { ContractDetail } from "./contractsShared";

const CALENDAR_BASES = ["calendar", "working"] as const;

export default function EditTermsModal({
  open,
  base,
  contract,
  onClose,
  onSaved,
}: {
  open: boolean;
  base: string;
  contract: ContractDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(contract.name);
  const [employer, setEmployer] = useState(contract.parties["employer"] ?? "");
  const [contractor, setContractor] = useState(contract.parties["contractor"] ?? "");
  const [administrator, setAdministrator] = useState(contract.parties["administrator"] ?? "");
  const [baseDate, setBaseDate] = useState(contract.baseDate ?? "");
  const [commencementDate, setCommencementDate] = useState(contract.commencementDate ?? "");
  const [completionDate, setCompletionDate] = useState(contract.completionDate ?? "");
  const [takingOverDate, setTakingOverDate] = useState(contract.takingOverDate ?? "");
  const [contractSum, setContractSum] = useState(
    contract.contractSum == null ? "" : String(contract.contractSum),
  );
  const [retentionPercent, setRetentionPercent] = useState(String(contract.retentionPercent));
  const [retentionCap, setRetentionCap] = useState(
    contract.retentionCap == null ? "" : String(contract.retentionCap),
  );
  const [defectsPeriodMonths, setDefectsPeriodMonths] = useState(
    contract.defectsPeriodMonths == null ? "" : String(contract.defectsPeriodMonths),
  );
  const [ldRatePerDay, setLdRatePerDay] = useState(
    contract.ldRatePerDay == null ? "" : String(contract.ldRatePerDay),
  );
  const [ldCap, setLdCap] = useState(contract.ldCap == null ? "" : String(contract.ldCap));
  const [paymentDueDays, setPaymentDueDays] = useState(
    contract.paymentDueDays == null ? "" : String(contract.paymentDueDays),
  );
  const [calendarBasis, setCalendarBasis] = useState(contract.calendarBasis);
  const [holidays, setHolidays] = useState((contract.holidays ?? []).join(", "));
  const [jurisdiction, setJurisdiction] = useState(contract.jurisdiction ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const num = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await api.patch(base, {
        name,
        parties: {
          ...(employer ? { employer } : {}),
          ...(contractor ? { contractor } : {}),
          ...(administrator ? { administrator } : {}),
        },
        baseDate: baseDate || null,
        commencementDate: commencementDate || null,
        completionDate: completionDate || null,
        takingOverDate: takingOverDate || null,
        contractSum: num(contractSum),
        retentionPercent: num(retentionPercent) ?? 0,
        retentionCap: num(retentionCap),
        defectsPeriodMonths: num(defectsPeriodMonths),
        ldRatePerDay: num(ldRatePerDay),
        ldCap: num(ldCap),
        paymentDueDays: num(paymentDueDays),
        calendarBasis,
        holidays: holidays
          .split(",")
          .map((h) => h.trim())
          .filter((h) => /^\d{4}-\d{2}-\d{2}$/.test(h)),
        jurisdiction: jurisdiction || null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to save the terms");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Edit contract terms" onClose={onClose} size="lg">
      <ErrorAlert message={error} />
      <p className="mb-3 text-xs text-ink-500">
        The form and NEC option decide which clause library the time-bar engine runs, so they are
        fixed once the contract is executed. Everything below can be corrected, and the change is
        ledgered.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Employer">
          <Input value={employer} onChange={(e) => setEmployer(e.target.value)} />
        </Field>
        <Field label="Contractor">
          <Input value={contractor} onChange={(e) => setContractor(e.target.value)} />
        </Field>
        <Field label="Engineer / Project Manager / CA" className="sm:col-span-2">
          <Input value={administrator} onChange={(e) => setAdministrator(e.target.value)} />
        </Field>

        <Field label="Base date">
          <Input type="date" value={baseDate} onChange={(e) => setBaseDate(e.target.value)} />
        </Field>
        <Field label="Commencement">
          <Input
            type="date"
            value={commencementDate}
            onChange={(e) => setCommencementDate(e.target.value)}
          />
        </Field>
        <Field label="Completion">
          <Input
            type="date"
            value={completionDate}
            onChange={(e) => setCompletionDate(e.target.value)}
          />
        </Field>
        <Field
          label="Taking-over / practical completion"
          hint="Stops delay damages accruing and starts the retention release clock."
        >
          <Input
            type="date"
            value={takingOverDate}
            onChange={(e) => setTakingOverDate(e.target.value)}
          />
        </Field>

        <Field label={`Contract sum (${contract.currency})`}>
          <Input
            value={contractSum}
            inputMode="decimal"
            onChange={(e) => setContractSum(e.target.value)}
          />
        </Field>
        <Field label="Retention %">
          <Input
            value={retentionPercent}
            inputMode="decimal"
            onChange={(e) => setRetentionPercent(e.target.value)}
          />
        </Field>
        <Field label="Retention cap" hint="Retention stops accruing once the cap is reached.">
          <Input
            value={retentionCap}
            inputMode="decimal"
            onChange={(e) => setRetentionCap(e.target.value)}
          />
        </Field>
        <Field label="Defects period (months)">
          <Input
            value={defectsPeriodMonths}
            inputMode="numeric"
            onChange={(e) => setDefectsPeriodMonths(e.target.value)}
          />
        </Field>
        <Field label="Delay damages per day">
          <Input
            value={ldRatePerDay}
            inputMode="decimal"
            onChange={(e) => setLdRatePerDay(e.target.value)}
          />
        </Field>
        <Field label="Delay damages cap">
          <Input value={ldCap} inputMode="decimal" onChange={(e) => setLdCap(e.target.value)} />
        </Field>
        <Field
          label="Payment due days"
          hint="Overrides the standard form's payment period when the contract states one."
        >
          <Input
            value={paymentDueDays}
            inputMode="numeric"
            onChange={(e) => setPaymentDueDays(e.target.value)}
          />
        </Field>
        <Field label="Deadline calendar">
          <Select value={calendarBasis} onChange={(e) => setCalendarBasis(e.target.value)}>
            {CALENDAR_BASES.map((b) => (
              <option key={b} value={b}>
                {b === "working" ? "Working days" : "Calendar days"}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Non-working days"
          hint="Comma-separated ISO dates, used when deadlines count working days."
          className="sm:col-span-2"
        >
          <Input
            value={holidays}
            onChange={(e) => setHolidays(e.target.value)}
            placeholder="2026-12-25, 2026-12-28"
          />
        </Field>
        <Field label="Governing law / jurisdiction" className="sm:col-span-2">
          <Input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
        </Field>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save terms"}
        </Button>
      </div>
    </Modal>
  );
}
