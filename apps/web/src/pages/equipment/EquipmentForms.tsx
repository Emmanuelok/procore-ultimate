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

/* ========================================================================== */
/* Assignment lifecycle — approve, mobilise, demobilise, cancel, transfer      */
/* ========================================================================== */

const CONDITIONS = ["new", "good", "serviceable", "damaged", "unserviceable"];

/**
 * The five acts that move a machine on and off a job. They are one component
 * because they share a machine, an assignment and a set of refusals, and
 * because splitting them made the drawer offer "Demobilise" for a machine
 * that had never arrived — which is the refusal the audit found nobody could
 * get past, since no route cancelled an assignment at all.
 */
export function AssignmentActionModal({
  open,
  action,
  onClose,
  onDone,
  projectId,
  assignmentId,
  machineLabel,
  projects,
}: {
  open: boolean;
  action: "approve" | "mobilise" | "demobilise" | "cancel" | "transfer" | null;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  assignmentId: string | null;
  machineLabel: string;
  /** other projects in the company, for a transfer */
  projects: Array<{ id: string; name: string }>;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [condition, setCondition] = useState("good");
  const [meterReading, setMeterReading] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("hire_not_required");
  const [toProjectId, setToProjectId] = useState("");
  const [requestOffHire, setRequestOffHire] = useState(false);

  if (!action || !assignmentId) return null;
  const base = `/api/v1/projects/${projectId}/equipment/assignments/${assignmentId}`;

  async function submit() {
    const done = await run(action!, () => {
      const meter = meterReading === "" ? null : Number(meterReading);
      const amount = cost === "" ? null : Number(cost);
      switch (action) {
        case "approve":
          return api.post(`${base}/approve`, {});
        case "mobilise":
          return api.post(`${base}/mobilise`, {
            conditionOnArrival: condition,
            meterReading: meter,
            mobilisationCost: amount,
            notes: note.trim() || null,
          });
        case "demobilise":
          return api.post(`${base}/demobilise`, {
            conditionOnReturn: condition,
            meterReading: meter,
            demobilisationCost: amount,
            damageOnReturnNote: note.trim() || null,
            requestOffHire,
          });
        case "cancel":
          return api.post(`${base}/cancel`, { reason, note: note.trim() || null });
        default:
          return api.post(`${base}/transfer`, {
            toProjectId,
            mobilisationCost: amount,
            notes: note.trim() || null,
          });
      }
    });
    if (done) {
      toast.success(
        action === "approve"
          ? "Hire approved"
          : action === "mobilise"
            ? "Mobilised — the arrival condition is the baseline any damage claim is argued against"
            : action === "demobilise"
              ? "Demobilised"
              : action === "cancel"
                ? "Assignment cancelled — the machine is free to be assigned again"
                : "Transferred",
      );
      onDone();
      onClose();
    }
  }

  const title =
    action === "approve"
      ? `Approve the hire of ${machineLabel}`
      : action === "mobilise"
        ? `Mobilise ${machineLabel}`
        : action === "demobilise"
          ? `Demobilise ${machineLabel}`
          : action === "cancel"
            ? `Cancel the assignment of ${machineLabel}`
            : `Transfer ${machineLabel} to another project`;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      description={
        action === "approve"
          ? "Approval of hire spend is refused to whoever requested it. The attempt is recorded either way."
          : action === "mobilise"
            ? "The condition recorded on arrival is the only baseline a damage charge on return can be argued against."
            : action === "demobilise"
              ? "Record the condition now, while the person who saw the machine come off the lorry can still be asked."
              : action === "cancel"
                ? "A machine that never arrived is cancelled, not demobilised. Until it is, it blocks every other project from booking it."
                : "The machine is demobilised from here and lands on the other project already approved — one movement, one ledger entry."
      }
      busy={busy === action}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel={
        action === "approve"
          ? "Approve"
          : action === "mobilise"
            ? "Mobilise"
            : action === "demobilise"
              ? "Demobilise"
              : action === "cancel"
                ? "Cancel assignment"
                : "Transfer"
      }
      disabled={action === "transfer" && toProjectId === ""}
      onSubmit={submit}
    >
      {action === "mobilise" || action === "demobilise" ? (
        <Field
          label={action === "mobilise" ? "Condition on arrival" : "Condition on return"}
          required
        >
          <Select value={condition} onChange={(e) => setCondition(e.target.value)}>
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {action === "transfer" ? (
        <Field label="Receiving project" required>
          <Select value={toProjectId} onChange={(e) => setToProjectId(e.target.value)}>
            <option value="">— choose —</option>
            {projects
              .filter((p) => p.id !== projectId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
      ) : null}
      {action === "cancel" ? (
        <Field label="Why" required>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {[
              "hire_not_required",
              "machine_unavailable",
              "raised_in_error",
              "transferred",
              "off_hired",
            ].map((r) => (
              <option key={r} value={r}>
                {r.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {action === "mobilise" || action === "demobilise" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Meter reading" optional hint="The meter never goes backwards: a lower figure is kept on the row but not written onto the machine.">
            <Input
              type="number"
              value={meterReading}
              onChange={(e) => setMeterReading(e.target.value)}
            />
          </Field>
          <Field
            label={action === "mobilise" ? "Mobilisation cost" : "Demobilisation cost"}
            optional
          >
            <Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {action === "transfer" ? (
        <Field label="Transport cost" optional>
          <Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
      ) : null}
      {action !== "approve" ? (
        <Field
          label={action === "demobilise" ? "Damage on return" : "Notes"}
          optional
          hint={
            action === "demobilise"
              ? "Anything the hire company could charge for. Written now, it is evidence; written after the invoice, it is an argument."
              : undefined
          }
        >
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      ) : null}
      {action === "demobilise" ? (
        <label className="flex items-start gap-2 text-meta">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={requestOffHire}
            onChange={(e) => setRequestOffHire(e.target.checked)}
          />
          <span>
            Request off-hire at the same time. Hire that is not stopped keeps running: the
            off-hire reference is the only thing that ends the charge.
          </span>
        </label>
      ) : null}
    </ModalShell>
  );
}

/* ========================================================================== */
/* Off-hire                                                                    */
/* ========================================================================== */

export function OffHireModal({
  open,
  onClose,
  onDone,
  equipmentId,
  machineLabel,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  equipmentId: string | null;
  machineLabel: string;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [action, setAction] = useState<"request" | "confirm" | "cancel">("request");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  if (!equipmentId) return null;

  async function submit() {
    const done = await run("offhire", () =>
      api.post(`/api/v1/companies/current/equipment/${equipmentId}/off-hire`, {
        action,
        reference: reference.trim() || null,
        note: note.trim() || null,
      }),
    );
    if (done) {
      toast.success(
        action === "request"
          ? "Off-hire requested — the charge runs until the hirer confirms it"
          : action === "confirm"
            ? "Off-hire confirmed and the live assignment closed"
            : "Off-hire cancelled",
      );
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Off-hire ${machineLabel}`}
      description="The off-hire reference from the hire company is the only thing that stops the charge. Requesting is not stopping it."
      busy={busy === "offhire"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record"
      onSubmit={submit}
    >
      <Field label="Act" required>
        <Select
          value={action}
          onChange={(e) => setAction(e.target.value as "request" | "confirm" | "cancel")}
        >
          <option value="request">Request off-hire</option>
          <option value="confirm">Confirm (the hirer has accepted it)</option>
          <option value="cancel">Cancel the request</option>
        </Select>
      </Field>
      {action === "confirm" ? (
        <Field
          label="Hire company's off-hire reference"
          optional
          hint="Without it the dispute over the last three weeks of hire has no document on our side."
        >
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Note" optional>
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ModalShell>
  );
}

/* ========================================================================== */
/* Maintenance — a schedule, and the record that closes it                      */
/* ========================================================================== */

const INTERVAL_KINDS = [
  "calendar_days",
  "calendar_months",
  "operating_hours",
  "distance",
  "cycles",
  "condition_based",
];
const MAINTENANCE_TYPES_UI = [
  "preventive",
  "statutory_inspection",
  "corrective",
  "breakdown",
  "overhaul",
  "calibration",
  "warranty_repair",
];
const MAINTENANCE_RESULTS_UI = ["completed", "partial", "deferred", "failed", "condemned"];

export function MaintenanceScheduleModal({
  open,
  onClose,
  onDone,
  equipmentId,
  machineLabel,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  equipmentId: string | null;
  machineLabel: string;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [name, setName] = useState("");
  const [maintenanceType, setMaintenanceType] = useState("preventive");
  const [intervalKind, setIntervalKind] = useState("operating_hours");
  const [intervalValue, setIntervalValue] = useState("500");
  const [warnAhead, setWarnAhead] = useState("");
  const [lastPerformedAt, setLastPerformedAt] = useState("");
  const [lastPerformedMeter, setLastPerformedMeter] = useState("");
  const [isStatutory, setIsStatutory] = useState(false);

  if (!equipmentId) return null;

  async function submit() {
    const done = await run("schedule", () =>
      api.post(`/api/v1/companies/current/equipment/${equipmentId}/maintenance-schedules`, {
        name: name.trim(),
        maintenanceType,
        intervalKind,
        intervalValue: Number(intervalValue),
        warnAheadValue: warnAhead === "" ? null : Number(warnAhead),
        lastPerformedAt: lastPerformedAt || null,
        lastPerformedMeter: lastPerformedMeter === "" ? null : Number(lastPerformedMeter),
        isStatutory,
      }),
    );
    if (done) {
      toast.success("Schedule created");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Maintenance schedule for ${machineLabel}`}
      description="Calendar and meter intervals race each other; whichever falls first is the due date. A meter interval on a machine whose meter has never been read is reported as NOT SCHEDULED rather than guessed."
      busy={busy === "schedule"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Create schedule"
      disabled={name.trim() === "" || intervalValue === ""}
      onSubmit={submit}
    >
      <Field label="Name" required>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="500-hour service"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" required>
          <Select
            value={maintenanceType}
            onChange={(e) => setMaintenanceType(e.target.value)}
          >
            {MAINTENANCE_TYPES_UI.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Interval measured in" required>
          <Select value={intervalKind} onChange={(e) => setIntervalKind(e.target.value)}>
            {INTERVAL_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Every" required>
          <Input
            type="number"
            value={intervalValue}
            onChange={(e) => setIntervalValue(e.target.value)}
          />
        </Field>
        <Field label="Warn ahead by" optional>
          <Input type="number" value={warnAhead} onChange={(e) => setWarnAhead(e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Last performed on" optional>
          <Input
            type="date"
            value={lastPerformedAt}
            onChange={(e) => setLastPerformedAt(e.target.value)}
          />
        </Field>
        <Field label="Meter at last service" optional>
          <Input
            type="number"
            value={lastPerformedMeter}
            onChange={(e) => setLastPerformedMeter(e.target.value)}
          />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-meta">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={isStatutory}
          onChange={(e) => setIsStatutory(e.target.checked)}
        />
        <span>
          Statutory. An overdue statutory examination on plant that is in service is an unlawful
          operation, not a housekeeping item, and is raised as a critical signal.
        </span>
      </label>
    </ModalShell>
  );
}

export function MaintenanceRecordModal({
  open,
  onClose,
  onDone,
  equipmentId,
  machineLabel,
  schedules,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  equipmentId: string | null;
  machineLabel: string;
  schedules: Array<{ scheduleId: string; name: string }>;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [scheduleId, setScheduleId] = useState("");
  const [maintenanceType, setMaintenanceType] = useState("preventive");
  const [description, setDescription] = useState("");
  const [performedAt, setPerformedAt] = useState(`${today()}T09:00`);
  const [meterReading, setMeterReading] = useState("");
  const [downtimeHours, setDowntimeHours] = useState("");
  const [partsCost, setPartsCost] = useState("");
  const [labourCost, setLabourCost] = useState("");
  const [result, setResult] = useState("completed");
  const [returnToService, setReturnToService] = useState(true);

  if (!equipmentId) return null;

  async function submit() {
    const done = await run("record", () =>
      api.post(`/api/v1/companies/current/equipment/${equipmentId}/maintenance-records`, {
        scheduleId: scheduleId || null,
        maintenanceType,
        description: description.trim() || null,
        performedAt: new Date(performedAt).toISOString(),
        meterReading: meterReading === "" ? null : Number(meterReading),
        downtimeHours: downtimeHours === "" ? null : Number(downtimeHours),
        partsCost: partsCost === "" ? null : Number(partsCost),
        labourCost: labourCost === "" ? null : Number(labourCost),
        result,
        returnedToServiceAt: returnToService ? new Date(performedAt).toISOString() : null,
      }),
    );
    if (done) {
      toast.success(
        scheduleId
          ? "Recorded, and the schedule moved on"
          : "Recorded — no schedule was named, so nothing was moved on",
      );
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Record maintenance on ${machineLabel}`}
      description="Name the schedule this closes. A service recorded against no schedule leaves the schedule overdue for ever, and the response will say so."
      busy={busy === "record"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record"
      onSubmit={submit}
    >
      <Field
        label="Closes which schedule"
        optional
        hint="Leaving this blank records the work but moves no due date."
      >
        <Select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
          <option value="">— none —</option>
          {schedules.map((s) => (
            <option key={s.scheduleId} value={s.scheduleId}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind" required>
          <Select value={maintenanceType} onChange={(e) => setMaintenanceType(e.target.value)}>
            {MAINTENANCE_TYPES_UI.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Outcome" required>
          <Select value={result} onChange={(e) => setResult(e.target.value)}>
            {MAINTENANCE_RESULTS_UI.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Performed at" required>
          <Input
            type="datetime-local"
            value={performedAt}
            onChange={(e) => setPerformedAt(e.target.value)}
          />
        </Field>
        <Field
          label="Meter reading"
          optional
          hint="This becomes the baseline the next meter interval is measured from."
        >
          <Input
            type="number"
            value={meterReading}
            onChange={(e) => setMeterReading(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Downtime hours" optional>
          <Input
            type="number"
            value={downtimeHours}
            onChange={(e) => setDowntimeHours(e.target.value)}
          />
        </Field>
        <Field label="Parts cost" optional>
          <Input type="number" value={partsCost} onChange={(e) => setPartsCost(e.target.value)} />
        </Field>
        <Field label="Labour cost" optional>
          <Input type="number" value={labourCost} onChange={(e) => setLabourCost(e.target.value)} />
        </Field>
      </div>
      <Field label="What was done" optional>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <label className="flex items-start gap-2 text-meta">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={returnToService}
          onChange={(e) => setReturnToService(e.target.checked)}
        />
        <span>The machine went back to work at that time.</span>
      </label>
    </ModalShell>
  );
}

/* ========================================================================== */
/* A meter or fuel reading                                                     */
/* ========================================================================== */

const READING_TYPES = [
  "hours",
  "odometer",
  "cycles",
  "fuel_fill",
  "fuel_level",
  "def_fill",
  "idle_hours",
];

export function ReadingModal({
  open,
  onClose,
  onDone,
  equipmentId,
  machineLabel,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  equipmentId: string | null;
  machineLabel: string;
  projectId: string;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [readingType, setReadingType] = useState("hours");
  const [value, setValue] = useState("");
  const [fuelLitres, setFuelLitres] = useState("");
  const [fuelCost, setFuelCost] = useState("");
  const [docketNumber, setDocketNumber] = useState("");
  const [readAt, setReadAt] = useState(`${today()}T08:00`);
  const [note, setNote] = useState<string | null>(null);

  if (!equipmentId) return null;
  const isFuel = readingType === "fuel_fill" || readingType === "def_fill";

  async function submit() {
    const done = await run("reading", () =>
      api.post<{ anomaly?: { isAnomalous?: boolean; reason?: string | null } }>(
        `/api/v1/companies/current/equipment/${equipmentId}/readings`,
        {
          readingType,
          readAt: new Date(readAt).toISOString(),
          value: value === "" ? null : Number(value),
          fuelLitres: fuelLitres === "" ? null : Number(fuelLitres),
          fuelCost: fuelCost === "" ? null : Number(fuelCost),
          docketNumber: docketNumber.trim() || null,
          projectId,
        },
      ),
    );
    if (done) {
      const anomaly = done.anomaly;
      if (anomaly?.isAnomalous) {
        // The reading is KEPT and flagged; it just does not advance the meter.
        setNote(
          anomaly.reason ??
            "The reading was stored but flagged as anomalous, so it has not advanced the machine's meter.",
        );
        toast.warning("Stored and flagged — it has not moved the machine's meter");
      } else {
        toast.success("Reading recorded");
      }
      onDone();
      if (!anomaly?.isAnomalous) onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Reading for ${machineLabel}`}
      description="An implausible reading is kept and flagged rather than dropped: the docket exists, and the anomaly is the finding."
      busy={busy === "reading"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Record reading"
      onSubmit={submit}
    >
      {note ? (
        <Alert tone="warning" title="Stored, and flagged">
          {note}
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What was read" required>
          <Select value={readingType} onChange={(e) => setReadingType(e.target.value)}>
            {READING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Read at" required>
          <Input
            type="datetime-local"
            value={readAt}
            onChange={(e) => setReadAt(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Value" optional={isFuel} required={!isFuel}>
        <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      {isFuel ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Litres" required>
            <Input
              type="number"
              value={fuelLitres}
              onChange={(e) => setFuelLitres(e.target.value)}
            />
          </Field>
          <Field label="Cost" optional>
            <Input type="number" value={fuelCost} onChange={(e) => setFuelCost(e.target.value)} />
          </Field>
          <Field label="Docket" optional>
            <Input value={docketNumber} onChange={(e) => setDocketNumber(e.target.value)} />
          </Field>
        </div>
      ) : null}
    </ModalShell>
  );
}

/* ========================================================================== */
/* Telematics device mapping                                                   */
/* ========================================================================== */

export function DeviceMapModal({
  open,
  onClose,
  onDone,
  fleet,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  fleet: EquipmentRecord[];
  devices: Array<{ providerKey: string; deviceId: string; readings: number }>;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [device, setDevice] = useState("");
  const [equipmentId, setEquipmentId] = useState("");

  async function submit() {
    const [providerKey, deviceId] = device.split("|");
    const done = await run<{ backfilledReadings?: number }>("map", () =>
      api.post(`/api/v1/companies/current/telematics/devices/map`, {
        providerKey,
        deviceId,
        equipmentId,
      }),
    );
    if (done) {
      toast.success(
        `Mapped — ${done.backfilledReadings ?? 0} historic reading(s) now belong to the machine`,
      );
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Map a telematics device to a machine"
      description="An unmapped device is not dropped: its readings are kept with a null machine and attached retrospectively the moment somebody says which machine it is."
      busy={busy === "map"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Map device"
      disabled={device === "" || equipmentId === ""}
      onSubmit={submit}
    >
      <Field label="Device" required>
        <Select value={device} onChange={(e) => setDevice(e.target.value)}>
          <option value="">— choose —</option>
          {devices.map((d) => (
            <option key={`${d.providerKey}|${d.deviceId}`} value={`${d.providerKey}|${d.deviceId}`}>
              {d.deviceId} · {d.providerKey} · {d.readings} reading(s)
            </option>
          ))}
        </Select>
      </Field>
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
    </ModalShell>
  );
}

/* ========================================================================== */
/* Deliveries — raise one, then receive it line by line                        */
/* ========================================================================== */

interface DeliveryLineDraft {
  key: string;
  materialItemId: string;
  description: string;
  unit: string;
  quantityExpected: string;
  unitCost: string;
}

let lineKeySeq = 0;
const newLineKey = () => `dl-${(lineKeySeq += 1)}`;

export function DeliveryModal({
  open,
  onClose,
  onDone,
  projectId,
  materials,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  materials: MaterialRow[];
}) {
  const { busy, refusal, clear, run } = useAction();
  const [deliveryNoteNumber, setDeliveryNoteNumber] = useState("");
  const [purchaseOrderRef, setPurchaseOrderRef] = useState("");
  const [carrierName, setCarrierName] = useState("");
  const [vehicleRegistration, setVehicleRegistration] = useState("");
  const [scheduledFor, setScheduledFor] = useState(`${today()}T08:00`);
  const [currency, setCurrency] = useState("USD");
  const [lines, setLines] = useState<DeliveryLineDraft[]>([
    { key: newLineKey(), materialItemId: "", description: "", unit: "", quantityExpected: "", unitCost: "" },
  ]);

  function patchLine(key: string, patch: Partial<DeliveryLineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit() {
    const done = await run("delivery", () =>
      api.post(`/api/v1/projects/${projectId}/material-deliveries`, {
        deliveryNoteNumber: deliveryNoteNumber.trim() || null,
        purchaseOrderRef: purchaseOrderRef.trim() || null,
        carrierName: carrierName.trim() || null,
        vehicleRegistration: vehicleRegistration.trim() || null,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        currency,
        lines: lines
          .filter((l) => l.description.trim() !== "" || l.materialItemId !== "")
          .map((l) => {
            const item = materials.find((m) => m.id === l.materialItemId);
            return {
              materialItemId: l.materialItemId || null,
              description: l.description.trim() || item?.name || "line",
              unit: l.unit.trim() || item?.unit || null,
              quantityExpected: l.quantityExpected === "" ? null : Number(l.quantityExpected),
              unitCost: l.unitCost === "" ? null : Number(l.unitCost),
            };
          }),
      }),
    );
    if (done) {
      toast.success("Delivery raised — receive it when the lorry is unloaded");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Raise a delivery"
      description="Booking the load before it arrives is what makes the discrepancy on arrival measurable: expected against received against accepted, per line."
      busy={busy === "delivery"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Raise delivery"
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delivery note number" optional>
          <Input
            value={deliveryNoteNumber}
            onChange={(e) => setDeliveryNoteNumber(e.target.value)}
          />
        </Field>
        <Field label="Purchase order" optional>
          <Input
            value={purchaseOrderRef}
            onChange={(e) => setPurchaseOrderRef(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Carrier" optional>
          <Input value={carrierName} onChange={(e) => setCarrierName(e.target.value)} />
        </Field>
        <Field label="Vehicle" optional>
          <Input
            value={vehicleRegistration}
            onChange={(e) => setVehicleRegistration(e.target.value)}
          />
        </Field>
        <Field label="Currency" required>
          <Input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
      </div>
      <Field label="Booked for" optional>
        <Input
          type="datetime-local"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)}
        />
      </Field>
      <div className="space-y-2">
        {lines.map((line) => (
          <div key={line.key} className="grid gap-2 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <Select
                value={line.materialItemId}
                onChange={(e) => {
                  const item = materials.find((m) => m.id === e.target.value);
                  patchLine(line.key, {
                    materialItemId: e.target.value,
                    ...(item
                      ? { description: item.name, unit: item.unit }
                      : {}),
                  });
                }}
              >
                <option value="">— free text line —</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.reference} · {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-3">
              <Input
                value={line.description}
                placeholder="Description"
                onChange={(e) => patchLine(line.key, { description: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                type="number"
                value={line.quantityExpected}
                placeholder="Qty"
                onChange={(e) => patchLine(line.key, { quantityExpected: e.target.value })}
              />
            </div>
            <div className="sm:col-span-2">
              <Input
                type="number"
                value={line.unitCost}
                placeholder="Unit cost"
                onChange={(e) => patchLine(line.key, { unitCost: e.target.value })}
              />
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setLines((prev) => [
              ...prev,
              {
                key: newLineKey(),
                materialItemId: "",
                description: "",
                unit: "",
                quantityExpected: "",
                unitCost: "",
              },
            ])
          }
        >
          Add a line
        </Button>
      </div>
    </ModalShell>
  );
}

export function ReceiveDeliveryModal({
  open,
  onClose,
  onDone,
  projectId,
  delivery,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  projectId: string;
  delivery: {
    id: string;
    reference: string;
    lines: Array<{
      id: string;
      description: string;
      unit: string | null;
      quantityExpected: number | null;
    }>;
  } | null;
}) {
  const { busy, refusal, clear, run } = useAction();
  const [rows, setRows] = useState<
    Record<string, { received: string; accepted: string; rejected: string; reason: string }>
  >({});
  const [receivedByName, setReceivedByName] = useState("");

  if (!delivery) return null;

  const rowFor = (lineId: string, expected: number | null) =>
    rows[lineId] ?? {
      received: expected === null ? "" : String(expected),
      accepted: expected === null ? "" : String(expected),
      rejected: "0",
      reason: "",
    };

  function patchRow(lineId: string, expected: number | null, patch: Partial<ReturnType<typeof rowFor>>) {
    setRows((prev) => ({ ...prev, [lineId]: { ...rowFor(lineId, expected), ...patch } }));
  }

  async function submit() {
    const done = await run("receive", () =>
      api.post(`/api/v1/projects/${projectId}/material-deliveries/${delivery!.id}/receive`, {
        receivedByName: receivedByName.trim() || null,
        lines: delivery!.lines.map((l) => {
          const r = rowFor(l.id, l.quantityExpected);
          return {
            lineId: l.id,
            quantityReceived: Number(r.received || 0),
            quantityAccepted: Number(r.accepted || 0),
            quantityRejected: Number(r.rejected || 0),
            rejectionReason: r.reason.trim() || null,
          };
        }),
      }),
    );
    if (done) {
      toast.success("Received — accepted quantities are booked into stock");
      onDone();
      onClose();
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={`Receive ${delivery.reference}`}
      description="Every unit that came off the lorry was either taken or refused. A line that does not add up is a line nobody has finished inspecting, and the whole receipt is refused rather than half-booked."
      busy={busy === "receive"}
      refusal={refusal}
      clearRefusal={clear}
      submitLabel="Receive"
      onSubmit={submit}
    >
      <Field label="Received by" optional>
        <Input value={receivedByName} onChange={(e) => setReceivedByName(e.target.value)} />
      </Field>
      <div className="space-y-3">
        {delivery.lines.map((line) => {
          const r = rowFor(line.id, line.quantityExpected);
          const rejected = Number(r.rejected || 0);
          return (
            <div key={line.id} className="rounded-md border border-line p-2">
              <p className="text-meta font-medium">
                {line.description}
                {line.quantityExpected !== null
                  ? ` · expected ${line.quantityExpected}${line.unit ? ` ${line.unit}` : ""}`
                  : " · no expected quantity"}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Field label="Received">
                  <Input
                    type="number"
                    value={r.received}
                    onChange={(e) =>
                      patchRow(line.id, line.quantityExpected, { received: e.target.value })
                    }
                  />
                </Field>
                <Field label="Accepted">
                  <Input
                    type="number"
                    value={r.accepted}
                    onChange={(e) =>
                      patchRow(line.id, line.quantityExpected, { accepted: e.target.value })
                    }
                  />
                </Field>
                <Field label="Rejected">
                  <Input
                    type="number"
                    value={r.rejected}
                    onChange={(e) =>
                      patchRow(line.id, line.quantityExpected, { rejected: e.target.value })
                    }
                  />
                </Field>
              </div>
              {rejected > 0 ? (
                <div className="mt-2">
                  <Field
                    label="Why it was rejected"
                    required
                    hint="A rejection with no reason cannot become a credit note or an NCR, which are the only two things a rejection is for."
                  >
                    <Input
                      value={r.reason}
                      onChange={(e) =>
                        patchRow(line.id, line.quantityExpected, { reason: e.target.value })
                      }
                    />
                  </Field>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
