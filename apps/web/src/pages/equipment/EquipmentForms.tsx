/**
 * THE WRITE SIDE of the plant and materials workspace.
 *
 * Every one of these forms renders the server's own refusal verbatim through
 * `RefusalNotice` rather than paraphrasing it. The refusals here are the
 * product: "no hire rate unit, so the amount cannot become a day's cost",
 * "this machine is already on another project", "the meter would go
 * backwards" — a form that swallowed those and said "Something went wrong"
 * would leave the user unable to act on any of them.
 */
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  Alert,
  Button,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
} from "../../ui";
import { api } from "../../lib/api";
import {
  RefusalNotice,
  today,
  useAction,
  type EquipmentRecord,
  type MaterialRow,
} from "./equipmentShared";

const CATEGORIES = [
  "earthmoving",
  "lifting",
  "access",
  "concrete",
  "compaction",
  "piling",
  "generator",
  "pump",
  "vehicle",
  "small_tool",
  "temporary_works",
  "site_accommodation",
  "survey",
  "other",
];

const OWNERSHIPS = ["owned", "hired", "operator_hired", "leased", "subcontractor"];
const RATE_UNITS = ["hour", "shift", "day", "week", "month", "cycle", "lump_sum"];
const METER_TYPES = ["hours", "kilometres", "miles", "cycles", "none"];
const CERTIFICATE_TYPES = [
  "thorough_examination",
  "loler",
  "puwer",
  "insurance_inspection",
  "calibration",
  "road_worthiness",
  "emissions",
  "operator_licence",
  "other",
];
const IDLE_REASONS = [
  "weather",
  "awaiting_materials",
  "awaiting_instruction",
  "breakdown",
  "no_operator",
  "access_blocked",
  "planned_standby",
  "other",
];
const MOVEMENT_TYPES = [
  "receipt",
  "issue",
  "return",
  "transfer_in",
  "transfer_out",
  "wastage",
  "damage",
  "theft",
  "adjustment",
];

function ModalShell({
  open,
  onClose,
  title,
  description,
  busy,
  refusal,
  clearRefusal,
  submitLabel,
  onSubmit,
  disabled,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  busy: boolean;
  refusal: ReturnType<typeof useAction>["refusal"];
  clearRefusal: () => void;
  submitLabel: string;
  onSubmit: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      {...(description ? { description } : {})}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={disabled} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {refusal ? <RefusalNotice refusal={refusal} onDismiss={clearRefusal} /> : null}
        {children}
      </div>
    </Modal>
  );
}

/* ========================================================================== */
/* Register a machine                                                          */
/* ========================================================================== */

export function RegisterPlantModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("earthmoving");
  const [ownership, setOwnership] = useState("hired");
  const [assetTag, setAssetTag] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [currency, setCurrency] = useState("GBP");
  const [hireRateAmount, setHireRateAmount] = useState("");
  const [hireRateUnit, setHireRateUnit] = useState("day");
  const [idleRateAmount, setIdleRateAmount] = useState("");
  const [internalRateAmount, setInternalRateAmount] = useState("");
  const [meterType, setMeterType] = useState("hours");
  const [currentMeterReading, setCurrentMeterReading] = useState("");
  const [hireStartDate, setHireStartDate] = useState("");
  const [hireEndDate, setHireEndDate] = useState("");
  const [isCritical, setIsCritical] = useState(false);
  const [requiresCertification, setRequiresCertification] = useState(false);

  const hired = ownership !== "owned";

  async function submit() {
    const done = await run("create", () =>
      api.post("/api/v1/companies/current/equipment", {
        name: name.trim(),
        category,
        ownership,
        currency: currency.toUpperCase(),
        assetTag: assetTag.trim() || null,
        manufacturer: manufacturer.trim() || null,
        model: model.trim() || null,
        serialNumber: serialNumber.trim() || null,
        hireRateAmount: hireRateAmount === "" ? null : Number(hireRateAmount),
        hireRateUnit: hireRateAmount === "" ? null : hireRateUnit,
        idleRateAmount: idleRateAmount === "" ? null : Number(idleRateAmount),
        internalRateAmount: internalRateAmount === "" ? null : Number(internalRateAmount),
        meterType,
        currentMeterReading: currentMeterReading === "" ? null : Number(currentMeterReading),
        hireStartDate: hireStartDate || null,
        hireEndDate: hireEndDate || null,
        isCritical,
        requiresCertification,
      }),
    );
    if (done) {
      toast.success("Plant registered");
      setName("");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Register plant"
      description="The fleet is company-wide; a machine visits projects. Its certificates and service history follow the machine, not the job."
      busy={busy === "create"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Register"
      disabled={name.trim() === ""}
      onSubmit={submit}
    >
      <Field label="Name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="30t tracked excavator"
          autoFocus
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ownership">
          <Select value={ownership} onChange={(e) => setOwnership(e.target.value)}>
            {OWNERSHIPS.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Asset tag" optional>
          <Input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Manufacturer" optional>
          <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
        </Field>
        <Field label="Model" optional>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </Field>
        <Field label="Serial number" optional>
          <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Currency">
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
            maxLength={3}
          />
        </Field>
        <Field
          label={hired ? "Hire rate" : "Hire rate"}
          hint={hired ? undefined : "Owned plant is usually costed on the internal rate instead."}
        >
          <Input
            type="number"
            value={hireRateAmount}
            onChange={(e) => setHireRateAmount(e.target.value)}
          />
        </Field>
        <Field label="Rate unit" hint="An amount with no unit cannot become a day's cost.">
          <Select value={hireRateUnit} onChange={(e) => setHireRateUnit(e.target.value)}>
            {RATE_UNITS.map((u) => (
              <option key={u} value={u}>
                per {u.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Standing (idle) rate" optional>
          <Input
            type="number"
            value={idleRateAmount}
            onChange={(e) => setIdleRateAmount(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Internal charge-out rate"
          optional
          hint="Per hour. Without it, owned plant costs nothing on the utilisation report."
        >
          <Input
            type="number"
            value={internalRateAmount}
            onChange={(e) => setInternalRateAmount(e.target.value)}
          />
        </Field>
        <Field label="Meter type">
          <Select value={meterType} onChange={(e) => setMeterType(e.target.value)}>
            {METER_TYPES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Current meter" optional>
          <Input
            type="number"
            value={currentMeterReading}
            onChange={(e) => setCurrentMeterReading(e.target.value)}
          />
        </Field>
      </div>
      {hired ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Hire start" optional>
            <Input
              type="date"
              value={hireStartDate}
              onChange={(e) => setHireStartDate(e.target.value)}
            />
          </Field>
          <Field
            label="Agreed hire end"
            optional
            hint="Every day past this with no off-hire is charged at the full rate."
          >
            <Input
              type="date"
              value={hireEndDate}
              onChange={(e) => setHireEndDate(e.target.value)}
            />
          </Field>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={isCritical}
            onChange={(e) => setIsCritical(e.target.checked)}
          />
          Critical plant — its failure stops the works or hurts somebody
        </label>
        <label className="flex items-center gap-2 text-meta">
          <input
            type="checkbox"
            checked={requiresCertification}
            onChange={(e) => setRequiresCertification(e.target.checked)}
          />
          Statutory examination required
        </label>
      </div>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Assign a machine to this project                                            */
/* ========================================================================== */

export function AssignPlantModal({
  open,
  onClose,
  onDone,
  projectId,
  fleet,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  fleet: EquipmentRecord[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [equipmentId, setEquipmentId] = useState("");
  const [assignedFrom, setAssignedFrom] = useState(today());
  const [assignedTo, setAssignedTo] = useState("");
  const [mobilisationCost, setMobilisationCost] = useState("");
  const [notes, setNotes] = useState("");

  async function submit() {
    const done = await run("assign", () =>
      api.post(`/api/v1/projects/${projectId}/equipment/assignments`, {
        equipmentId,
        assignedFrom,
        assignedTo: assignedTo || null,
        mobilisationCost: mobilisationCost === "" ? null : Number(mobilisationCost),
        notes: notes.trim() || null,
      }),
    );
    if (done) {
      toast.success("Assignment raised — it still needs approving by somebody else");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Assign plant to this project"
      description="The request is raised here and approved by somebody else: the hire spend is a decision, and the person who wants the machine is not the person who signs for it."
      busy={busy === "assign"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Raise assignment"
      disabled={equipmentId === ""}
      onSubmit={submit}
    >
      <Field label="Machine" required>
        <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
          <option value="">— choose —</option>
          {fleet.map((m) => (
            <option key={m.id} value={m.id}>
              {m.reference} · {m.name}
              {m.projectId ? " (currently on another project)" : ""}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="On site from" required>
          <Input
            type="date"
            value={assignedFrom}
            onChange={(e) => setAssignedFrom(e.target.value)}
          />
        </Field>
        <Field label="Expected off" optional>
          <Input type="date" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} />
        </Field>
      </div>
      <Field
        label="Mobilisation cost"
        optional
        hint="Transport is the cost most often forgotten until the haulier's invoice arrives, and it is rarely in the hire rate."
      >
        <Input
          type="number"
          value={mobilisationCost}
          onChange={(e) => setMobilisationCost(e.target.value)}
        />
      </Field>
      <Field label="Notes" optional>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* A day's utilisation                                                         */
/* ========================================================================== */

export function UtilisationModal({
  open,
  onClose,
  onDone,
  projectId,
  fleet,
  defaultEquipmentId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  fleet: EquipmentRecord[];
  defaultEquipmentId?: string | null;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [equipmentId, setEquipmentId] = useState(defaultEquipmentId ?? "");
  const [utilisationDate, setUtilisationDate] = useState(today());
  const [availableHours, setAvailableHours] = useState("10");
  const [workingHours, setWorkingHours] = useState("");
  const [idleHours, setIdleHours] = useState("");
  const [standbyHours, setStandbyHours] = useState("");
  const [downtimeHours, setDowntimeHours] = useState("");
  const [idleReason, setIdleReason] = useState("");
  const [meterEnd, setMeterEnd] = useState("");
  const [fuelLitres, setFuelLitres] = useState("");
  const [notes, setNotes] = useState("");
  const [meterNote, setMeterNote] = useState<string | null>(null);

  const num = (v: string) => (v === "" ? undefined : Number(v));

  async function submit() {
    const done = await run("save", () =>
      api.post<{ meter?: { advanced: boolean; note: string | null } }>(
        `/api/v1/projects/${projectId}/equipment-utilisation`,
        {
          equipmentId,
          utilisationDate,
          availableHours: num(availableHours),
          workingHours: num(workingHours) ?? 0,
          idleHours: num(idleHours),
          standbyHours: num(standbyHours),
          downtimeHours: num(downtimeHours),
          idleReason: idleReason || null,
          meterEnd: num(meterEnd),
          fuelLitres: num(fuelLitres),
          notes: notes.trim() || null,
        },
      ),
    );
    if (done) {
      setMeterNote(done.meter?.note ?? null);
      toast.success("Day recorded");
      onDone();
      if (!done.meter?.note) onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Record a plant day"
      description="Working, idle, standby and downtime. The split is the whole point: a machine that was available and did nothing still cost the full rate."
      busy={busy === "save"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record the day"
      disabled={equipmentId === ""}
      onSubmit={submit}
    >
      {meterNote ? (
        <Alert tone="warning" title="The machine's meter was not moved">
          {meterNote}
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Machine" required>
          <Select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
            <option value="">— choose —</option>
            {fleet.map((m) => (
              <option key={m.id} value={m.id}>
                {m.reference} · {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date" required>
          <Input
            type="date"
            value={utilisationDate}
            onChange={(e) => setUtilisationDate(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label="Available h">
          <Input
            type="number"
            value={availableHours}
            onChange={(e) => setAvailableHours(e.target.value)}
          />
        </Field>
        <Field label="Working h">
          <Input
            type="number"
            value={workingHours}
            onChange={(e) => setWorkingHours(e.target.value)}
          />
        </Field>
        <Field label="Idle h">
          <Input type="number" value={idleHours} onChange={(e) => setIdleHours(e.target.value)} />
        </Field>
        <Field label="Standby h">
          <Input
            type="number"
            value={standbyHours}
            onChange={(e) => setStandbyHours(e.target.value)}
          />
        </Field>
        <Field label="Downtime h">
          <Input
            type="number"
            value={downtimeHours}
            onChange={(e) => setDowntimeHours(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Idle reason"
          hint='"Awaiting materials" and "weather" produce entirely different conversations, and one of them is recoverable.'
        >
          <Select value={idleReason} onChange={(e) => setIdleReason(e.target.value)}>
            <option value="">— none —</option>
            {IDLE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Meter at end of day" optional>
          <Input type="number" value={meterEnd} onChange={(e) => setMeterEnd(e.target.value)} />
        </Field>
        <Field label="Fuel (litres)" optional>
          <Input type="number" value={fuelLitres} onChange={(e) => setFuelLitres(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes" optional>
        <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Certificates                                                                */
/* ========================================================================== */

export function CertificateModal({
  open,
  onClose,
  onDone,
  equipmentId,
  equipmentLabel,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  equipmentId: string;
  equipmentLabel: string;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [certificateType, setCertificateType] = useState("thorough_examination");
  const [certificateNumber, setCertificateNumber] = useState("");
  const [issuedByName, setIssuedByName] = useState("");
  const [issuedAt, setIssuedAt] = useState(today());
  const [validFrom, setValidFrom] = useState(today());
  const [validTo, setValidTo] = useState("");
  const [result, setResult] = useState("pass");
  const [safeWorkingLoad, setSafeWorkingLoad] = useState("");
  const [conditions, setConditions] = useState("");

  async function submit() {
    const done = await run("save", () =>
      api.post(`/api/v1/companies/current/equipment/${equipmentId}/certificates`, {
        certificateType,
        certificateNumber: certificateNumber.trim() || null,
        issuedByName: issuedByName.trim() || null,
        issuedAt: issuedAt || null,
        validFrom: validFrom || null,
        validTo,
        result,
        safeWorkingLoad: safeWorkingLoad.trim() || null,
        conditions: conditions.trim() || null,
      }),
    );
    if (done) {
      toast.success("Certificate recorded — earlier ones of the same type are now superseded");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Certificate — ${equipmentLabel}`}
      description="validTo is the column this table exists for. An expired statutory certificate on a machine that is lifting today is unlawful operation, not overdue paperwork."
      busy={busy === "save"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record certificate"
      disabled={validTo === ""}
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" required>
          <Select value={certificateType} onChange={(e) => setCertificateType(e.target.value)}>
            {CERTIFICATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Certificate number" optional>
          <Input
            value={certificateNumber}
            onChange={(e) => setCertificateNumber(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Issued by" optional hint="The competent person or body that examined it.">
        <Input value={issuedByName} onChange={(e) => setIssuedByName(e.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Issued">
          <Input type="date" value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
        </Field>
        <Field label="Valid from">
          <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </Field>
        <Field label="Valid to" required>
          <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Result">
          <Select value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="pass">Pass</option>
            <option value="pass_with_conditions">Pass with conditions</option>
            <option value="fail">Fail</option>
          </Select>
        </Field>
        <Field label="Safe working load" optional>
          <Input
            value={safeWorkingLoad}
            onChange={(e) => setSafeWorkingLoad(e.target.value)}
            placeholder="e.g. 3.2 t at 12 m"
          />
        </Field>
      </div>
      <Field label="Conditions / defects noted" optional>
        <Textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Stock movement                                                              */
/* ========================================================================== */

export function StockMovementModal({
  open,
  onClose,
  onDone,
  projectId,
  materials,
  defaultItemId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  materials: MaterialRow[];
  defaultItemId?: string | null;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [materialItemId, setMaterialItemId] = useState(defaultItemId ?? "");
  const [movementType, setMovementType] = useState("issue");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);

  const projectItems = materials.filter((m) => m.projectId !== null);

  async function submit() {
    const done = await run("save", () =>
      api.post(`/api/v1/projects/${projectId}/material-stock-movements`, {
        materialItemId,
        movementType,
        quantity: Number(quantity),
        reason: reason.trim() || null,
        allowNegative,
      }),
    );
    if (done) {
      toast.success("Movement recorded");
      setQuantity("");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Move stock"
      description="Wastage, damage and theft are separate kinds on purpose: an 'adjustment' that covers all three makes material loss unmeasurable."
      busy={busy === "save"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record movement"
      disabled={materialItemId === "" || quantity === ""}
      onSubmit={submit}
    >
      <Field
        label="Material"
        required
        hint="Company catalogue items hold no stock — their balance is shared by every project."
      >
        <Select value={materialItemId} onChange={(e) => setMaterialItemId(e.target.value)}>
          <option value="">— choose —</option>
          {projectItems.map((m) => (
            <option key={m.id} value={m.id}>
              {m.reference} · {m.name} ({m.unit})
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Movement">
          <Select value={movementType} onChange={(e) => setMovementType(e.target.value)}>
            {MOVEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Quantity"
          required
          hint="Positive. The movement kind supplies the direction; only an adjustment may be signed."
        >
          <Input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
      </div>
      <Field label="Reason" optional>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <label className="flex items-start gap-2 text-meta">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={allowNegative}
          onChange={(e) => setAllowNegative(e.target.checked)}
        />
        <span>
          Force it even if the balance goes negative. The override is signalled: negative stock
          means material either arrived and was never booked in, or left and was never booked out.
        </span>
      </label>
    </ModalShell>
  );
}
