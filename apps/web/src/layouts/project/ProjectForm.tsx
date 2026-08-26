/**
 * The project form, shared by "New project" (portfolio page) and "Edit project
 * details" (workspace header). One definition means the two can never drift
 * apart on which fields exist or which stage values are legal.
 *
 * `stage` is bound to PROJECT_STAGES from @constructos/shared — the same array
 * the API's zod enum is built from, so the select cannot offer a value the
 * server will reject.
 */
import type { ReactNode } from "react";
import { PROJECT_STAGES } from "@constructos/shared";
import { DatePicker, Field, FormSection, Input, NumberInput, Select, Textarea } from "../../ui";
import { PROJECT_STAGE_LABEL, type ProjectRecord } from "./lib";

export interface ProjectFormValues {
  name: string;
  number: string;
  stage: string;
  type: string;
  department: string;
  address: string;
  city: string;
  country: string;
  startDate: string;
  finishDate: string;
  currency: string;
  value: number | null;
  description: string;
}

export const EMPTY_PROJECT_FORM: ProjectFormValues = {
  name: "",
  number: "",
  stage: "pre_construction",
  type: "",
  department: "",
  address: "",
  city: "",
  country: "",
  startDate: "",
  finishDate: "",
  currency: "USD",
  value: null,
  description: "",
};

export function projectFormFrom(record: ProjectRecord): ProjectFormValues {
  return {
    name: record.name ?? "",
    number: record.number ?? "",
    stage: record.stage ?? "pre_construction",
    type: record.type ?? "",
    department: record.department ?? "",
    address: record.address ?? "",
    city: record.city ?? "",
    country: record.country ?? "",
    startDate: record.startDate ?? "",
    finishDate: record.finishDate ?? "",
    currency: record.currency ?? "USD",
    value: record.value ?? null,
    description: record.description ?? "",
  };
}

/**
 * Blank optional fields are OMITTED, not sent as null: the create and patch
 * schemas accept `undefined` but not `null` for these, and sending null is a
 * 400 rather than a clear.
 */
export function buildProjectPayload(values: ProjectFormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { name: values.name.trim() };
  const text = (key: keyof ProjectFormValues, field: string) => {
    const raw = values[key];
    if (typeof raw === "string" && raw.trim()) payload[field] = raw.trim();
  };
  text("number", "number");
  text("type", "type");
  text("department", "department");
  text("address", "address");
  text("city", "city");
  text("country", "country");
  text("startDate", "startDate");
  text("finishDate", "finishDate");
  text("description", "description");
  if (values.stage) payload["stage"] = values.stage;
  if (values.currency.trim()) payload["currency"] = values.currency.trim().toUpperCase();
  if (values.value !== null && Number.isFinite(values.value)) payload["value"] = values.value;
  return payload;
}

/** Client-side checks that mirror the server's, so the round trip is skipped. */
export function validateProjectForm(values: ProjectFormValues): string | null {
  if (!values.name.trim()) return "A project name is required.";
  if (values.name.trim().length > 200) return "The project name is limited to 200 characters.";
  if (values.currency.trim() && values.currency.trim().length !== 3) {
    return "Currency must be a three-letter ISO 4217 code, for example USD, GBP or AED.";
  }
  if (values.startDate && values.finishDate && values.finishDate < values.startDate) {
    return "The finish date is before the start date.";
  }
  return null;
}

function toDate(iso: string): Date | null {
  if (!iso) return null;
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fromDate(date: Date | null): string {
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface ProjectFormFieldsProps {
  values: ProjectFormValues;
  onChange: (next: ProjectFormValues) => void;
  /** Extra note rendered under the identity section. */
  note?: ReactNode;
  disabled?: boolean;
}

export function ProjectFormFields({
  values,
  onChange,
  note,
  disabled = false,
}: ProjectFormFieldsProps) {
  function set<K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="space-y-5">
      <FormSection title="Identity" description="What this project is called and where it sits.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Project name" required>
            <Input
              required
              disabled={disabled}
              value={values.name}
              maxLength={200}
              onChange={(event) => set("name", event.target.value)}
              placeholder="Riverside Medical Centre"
            />
          </Field>
          <Field label="Project number" hint="Your own reference. Optional.">
            <Input
              disabled={disabled}
              value={values.number}
              maxLength={50}
              onChange={(event) => set("number", event.target.value)}
              placeholder="24-018"
            />
          </Field>
          <Field label="Stage">
            <Select
              disabled={disabled}
              value={values.stage}
              onChange={(event) => set("stage", event.target.value)}
            >
              {PROJECT_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {PROJECT_STAGE_LABEL[stage] ?? stage}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" hint="Sector or delivery type — free text.">
            <Input
              disabled={disabled}
              value={values.type}
              maxLength={100}
              onChange={(event) => set("type", event.target.value)}
              placeholder="Healthcare · Design & Build"
            />
          </Field>
          <Field label="Department">
            <Input
              disabled={disabled}
              value={values.department}
              maxLength={100}
              onChange={(event) => set("department", event.target.value)}
              placeholder="Major Projects"
            />
          </Field>
        </div>
        {note}
      </FormSection>

      <FormSection title="Location">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Address" className="sm:col-span-2">
            <Input
              disabled={disabled}
              value={values.address}
              maxLength={300}
              onChange={(event) => set("address", event.target.value)}
              placeholder="100 River Road"
            />
          </Field>
          <Field label="City">
            <Input
              disabled={disabled}
              value={values.city}
              maxLength={100}
              onChange={(event) => set("city", event.target.value)}
            />
          </Field>
          <Field label="Country">
            <Input
              disabled={disabled}
              value={values.country}
              maxLength={100}
              onChange={(event) => set("country", event.target.value)}
            />
          </Field>
        </div>
      </FormSection>

      <FormSection
        title="Dates and value"
        description="The value recorded here is the project's headline figure. Contract sums live on the prime contract and are never overwritten from this form."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Start date">
            <DatePicker
              disabled={disabled}
              value={toDate(values.startDate)}
              onChange={(date) => set("startDate", fromDate(date))}
              placeholder="Not set"
              aria-label="Project start date"
            />
          </Field>
          <Field label="Finish date">
            <DatePicker
              disabled={disabled}
              value={toDate(values.finishDate)}
              onChange={(date) => set("finishDate", fromDate(date))}
              placeholder="Not set"
              aria-label="Project finish date"
            />
          </Field>
          <Field label="Currency" hint="ISO 4217, three letters.">
            <Input
              disabled={disabled}
              value={values.currency}
              maxLength={3}
              onChange={(event) => set("currency", event.target.value.toUpperCase())}
              placeholder="USD"
              className="uppercase"
            />
          </Field>
          <Field label="Project value" hint="Leave blank if it is not known yet.">
            <NumberInput
              disabled={disabled}
              value={values.value}
              onChange={(next) => set("value", next)}
              min={0}
              precision={2}
              step={1000}
              align="right"
              prefix={values.currency || "USD"}
              placeholder="Not stated"
              aria-label="Project value"
            />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Description">
        <Field label="Scope and delivery notes">
          <Textarea
            disabled={disabled}
            value={values.description}
            maxLength={5000}
            rows={4}
            onChange={(event) => set("description", event.target.value)}
            placeholder="Scope, delivery method, key milestones…"
          />
        </Field>
      </FormSection>
    </div>
  );
}
