/**
 * OVERVIEW — which regime this project sits under, how the tenant stands in
 * it (the customer side of every determination), and the code-resident
 * regime library as reference. The profile is the one thing on this page a
 * person types; everything else is derived and says where it came from.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  Drawer,
  Field,
  Input,
  Select,
  Textarea,
  toast,
  type DataColumns,
} from "../../ui";
import { IconCompliance, IconEdit } from "../../ui/icons";
import {
  CONTRACT_TYPES,
  DASH,
  LoadError,
  LoadingBlock,
  ReasonList,
  Row,
  SUPPLY_TYPES,
  count,
  isoDate,
  money,
  pct,
  taxApi,
  titleCase,
  useAction,
  useProfile,
  useRegimeDef,
  useRegimes,
  type RegimeSummary,
  type WithholdingRule,
} from "./taxShared";

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export default function OverviewTab({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const profile = useProfile(projectId);
  const regimes = useRegimes();
  const [editing, setEditing] = useState(false);
  const [openRegime, setOpenRegime] = useState<string | null>(null);

  const p = profile.data;
  const resolvedRegime = p?.resolved.regime ?? null;

  const columns = useMemo<DataColumns<RegimeSummary>>(
    () => [
      { id: "regime", header: "Code", accessor: "regime", type: "code", width: 80, mono: true, cell: ({ row }) => <span className="font-mono uppercase">{row.regime}</span> },
      { id: "name", header: "Regime", accessor: "name", type: "text", width: 300 },
      { id: "jurisdiction", header: "Jurisdiction", accessor: "jurisdiction", type: "text", width: 150 },
      { id: "standardRate", header: "Standard rate", accessor: "standardRate", type: "number", align: "right", width: 120, cell: ({ row }) => (row.indirectTaxKind === "none" ? "no VAT/GST" : pct(row.standardRate)) },
      { id: "drc", header: "Domestic reverse charge", accessor: (row) => (row.domesticReverseCharge ? "yes" : "no"), type: "text", width: 170 },
      { id: "withholding", header: "Deduction scheme", accessor: (row) => row.withholdingName ?? "none", type: "text", width: 220 },
      { id: "returns", header: "Returns", accessor: (row) => row.returns.join("; "), type: "text", width: 320 },
      { id: "pe", header: "PE days (site / individual)", accessor: (row) => `${row.peConstructionSiteDays} / ${row.peServiceDays}`, type: "text", width: 170 },
      { id: "ratesAsAt", header: "Rates as at", accessor: "ratesAsAt", type: "date", width: 120 },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Regime for this project"
            actions={
              <Button size="sm" variant="secondary" icon={IconEdit} onClick={() => setEditing(true)} disabled={profile.loading}>
                {p?.profile ? "Edit profile" : "Set profile"}
              </Button>
            }
          />
          <CardBody>
            {profile.loading && !p ? <LoadingBlock rows={4} /> : null}
            {profile.error ? <LoadError message={profile.error} onRetry={profile.reload} /> : null}
            {p ? (
              <dl className="divide-y divide-border">
                <Row label="Regime">
                  {resolvedRegime ? (
                    <button type="button" className="font-semibold text-accent-text hover:underline" onClick={() => setOpenRegime(resolvedRegime)}>
                      {p.regimeDef?.name ?? resolvedRegime.toUpperCase()}
                    </button>
                  ) : (
                    <span className="italic text-content-subtle">not resolved</span>
                  )}
                </Row>
                <Row label="Resolved from">
                  <Badge tone={p.resolved.source === "profile" ? "success" : p.resolved.source === "project_country" ? "warning" : "danger"} size="xs">
                    {p.resolved.source === "profile" ? "project tax profile" : p.resolved.source === "project_country" ? `project country (${p.project?.country ?? DASH})` : "nothing"}
                  </Badge>
                </Row>
                <Row label="Place of supply">{p.profile?.placeOfSupplyCountry ?? p.regimeDef?.countryCode ?? DASH}</Row>
                <Row label="Currency">{p.profile?.currency ?? p.project?.currency ?? DASH}</Row>
                <Row label="Defaults">
                  {p.profile ? `${titleCase(p.profile.defaultSupplyType)} · ${titleCase(p.profile.defaultContractType)}` : DASH}
                </Row>
                <Row label="Tenant VAT/GST-registered" hint="Drives the reverse charge">
                  {yesNo(p.customerPosition?.vatRegistered)}
                </Row>
                <Row label="Tenant inside the deduction scheme" hint="UK CIS contractor / IE RCT principal">
                  {yesNo(p.customerPosition?.deductionRegistered)}
                </Row>
                <Row label="Tenant is an end user" hint="UK: excludes the domestic reverse charge">
                  {yesNo(p.customerPosition?.endUser ?? false)}
                </Row>
                {p.profile?.notes ? <Row label="Notes">{p.profile.notes}</Row> : null}
              </dl>
            ) : null}
            {p && p.resolved.reasons.length > 0 ? <ReasonList reasons={p.resolved.reasons} className="mt-3" /> : null}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="What the regime means here" />
          <CardBody>
            {p?.regimeDef ? (
              <div className="space-y-3">
                <p className="text-meta text-content">{p.regimeDef.summary}</p>
                <dl className="divide-y divide-border">
                  <Row label="Indirect tax">
                    {p.regimeDef.indirectTaxKind === "none" ? "none (no VAT/GST)" : `${p.regimeDef.indirectTaxKind.toUpperCase()} at ${pct(p.regimeDef.standardRate)}`}
                  </Row>
                  <Row label="Domestic reverse charge for construction">{p.regimeDef.domesticReverseCharge ? "yes" : "no"}</Row>
                  <Row label="Deduction scheme">{p.regimeDef.withholdingName ?? "none"}</Row>
                  <Row label="Levies">{p.regimeDef.levies.length > 0 ? p.regimeDef.levies.join(", ") : "none"}</Row>
                  <Row label="Returns">{p.regimeDef.returns.length > 0 ? p.regimeDef.returns.join("; ") : "none in the library"}</Row>
                  <Row label="PE thresholds" hint="building site / individual presence">
                    {p.regimeDef.peConstructionSiteDays} / {p.regimeDef.peServiceDays} days
                  </Row>
                  <Row label="E-invoicing">{p.regimeDef.eInvoicing ?? "no mandate noted"}</Row>
                  <Row label="Rates pinned as at">{isoDate(p.regimeDef.ratesAsAt)}</Row>
                </dl>
                <Button size="sm" variant="ghost" onClick={() => setOpenRegime(p.regimeDef!.regime)}>
                  Read the full definition
                </Button>
              </div>
            ) : profile.loading ? (
              <LoadingBlock rows={3} />
            ) : (
              <Alert tone="warning" title="No regime resolved" size="sm">
                Set a profile so the engine knows which rules to cite. Until then determinations must name a regime explicitly.
              </Alert>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Regime library"
          subtitle="Code-resident reference data: rates pinned at a date and cited. Reduced and zero rates are opt-in, thresholds apply per payment, and the notes say what is not computed."
        />
        <CardBody flush>
          {regimes.error ? (
            <div className="p-4">
              <LoadError message={regimes.error} onRetry={regimes.reload} />
            </div>
          ) : (
            <DataTable<RegimeSummary>
              tableId="tax.regimes"
              data={regimes.data?.items ?? []}
              columns={columns}
              getRowId={(row) => row.regime}
              loading={regimes.loading && !regimes.data}
              height={440}
              rowHeight={44}
              stickyHeader
              flush
              exportFileName="tax-regimes"
              onRowClick={({ row }) => setOpenRegime(row.regime)}
              rowTone={(row) => (row.regime === resolvedRegime ? "accent" : undefined)}
              aria-label="Tax regime library"
            />
          )}
        </CardBody>
      </Card>

      <ProfileDrawer
        projectId={projectId}
        open={editing}
        onClose={() => setEditing(false)}
        regimes={regimes.data?.items ?? []}
        initial={p}
        onSaved={() => {
          setEditing(false);
          profile.reload();
          onChanged();
        }}
      />
      <RegimeDrawer regime={openRegime} onClose={() => setOpenRegime(null)} />
    </div>
  );
}

/* ============================== Profile form ============================== */

function ProfileDrawer({
  projectId,
  open,
  onClose,
  regimes,
  initial,
  onSaved,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  regimes: RegimeSummary[];
  initial: ReturnType<typeof useProfile>["data"];
  onSaved: () => void;
}) {
  const action = useAction();
  const [regime, setRegime] = useState("uk");
  const [place, setPlace] = useState("");
  const [vat, setVat] = useState(false);
  const [ded, setDed] = useState(false);
  const [endUser, setEndUser] = useState(false);
  const [supply, setSupply] = useState<string>("construction_services");
  const [contract, setContract] = useState<string>("subcontract");
  const [currency, setCurrency] = useState("");
  const [notes, setNotes] = useState("");
  const [custom, setCustom] = useState("{}");
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const pr = initial?.profile;
    setRegime(pr?.regime ?? initial?.resolved.regime ?? regimes[0]?.regime ?? "uk");
    setPlace(pr?.placeOfSupplyCountry ?? "");
    setVat(pr ? pr.customerVatRegistered === 1 : false);
    setDed(pr ? pr.customerDeductionRegistered === 1 : false);
    setEndUser(pr ? pr.endUser === 1 : false);
    setSupply(pr?.defaultSupplyType ?? "construction_services");
    setContract(pr?.defaultContractType ?? "subcontract");
    setCurrency(pr?.currency ?? initial?.project?.currency ?? "");
    setNotes(pr?.notes ?? "");
    setCustom(JSON.stringify(pr?.customRules ?? {}, null, 2));
    setCustomError(null);
    action.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let customRules: Record<string, unknown> = {};
    if (regime === "custom") {
      try {
        const parsed: unknown = JSON.parse(custom || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be a JSON object");
        customRules = parsed as Record<string, unknown>;
        setCustomError(null);
      } catch (err) {
        setCustomError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
    }
    const body: Record<string, unknown> = {
      regime,
      customerVatRegistered: vat,
      customerDeductionRegistered: ded,
      endUser,
      defaultSupplyType: supply,
      defaultContractType: contract,
      customRules,
    };
    if (place.trim()) body["placeOfSupplyCountry"] = place.trim().toUpperCase();
    if (currency.trim()) body["currency"] = currency.trim().toUpperCase();
    body["notes"] = notes.trim() || null;
    const saved = await action.run("save", () => taxApi.saveProfile(projectId, body));
    if (saved) {
      toast.success("Tax profile saved");
      onSaved();
    }
  }

  const selected = regimes.find((r) => r.regime === regime);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title="Project tax profile"
      description="The tenant's own position in the regime. The engine reads this as the customer side of every determination."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="tax-profile-form" loading={action.busy === "save"}>
            Save profile
          </Button>
        </div>
      }
    >
      <form id="tax-profile-form" onSubmit={submit} className="space-y-4">
        {action.error ? <Alert tone="danger" size="sm">{action.error}</Alert> : null}
        <Field label="Regime" required hint={selected ? selected.summary : undefined}>
          <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
            {regimes.map((r) => (
              <option key={r.regime} value={r.regime}>
                {r.name}
              </option>
            ))}
            {regimes.length === 0 ? <option value="uk">United Kingdom</option> : null}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Place of supply (ISO-2)" hint={`Defaults to the regime country${selected ? ` (${selected.countryCode || "none"})` : ""}`}>
            <Input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={2} placeholder={selected?.countryCode ?? "GB"} />
          </Field>
          <Field label="Currency" hint={`Defaults to the regime currency${selected ? ` (${selected.currency})` : ""}`}>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} placeholder={selected?.currency ?? "GBP"} />
          </Field>
        </div>
        <div className="space-y-2">
          <Checkbox checked={vat} onChange={(e) => setVat(e.target.checked)} label="The tenant is VAT/GST-registered in this regime" description="Required for the domestic reverse charge to apply to supplies we receive." />
          <Checkbox checked={ded} onChange={(e) => setDed(e.target.checked)} label="The tenant is inside the deduction scheme" description="UK: registered CIS contractor. IE: RCT principal. Without it there is no duty to deduct." />
          <Checkbox checked={endUser} onChange={(e) => setEndUser(e.target.checked)} label="The tenant is an end user" description="UK: an end user is outside the reverse charge and is invoiced VAT normally." />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default supply type">
            <Select value={supply} onChange={(e) => setSupply(e.target.value)}>
              {SUPPLY_TYPES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default contract type">
            <Select value={contract} onChange={(e) => setContract(e.target.value)}>
              {CONTRACT_TYPES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {regime === "custom" ? (
          <Field
            label="Custom rules (JSON)"
            required
            error={customError}
            hint='Keys: vatRate, vatTreatment, reverseCharge, withholdingRate, withholdingBase, citation. Nothing is assumed; cite the source.'
          >
            <Textarea value={custom} onChange={(e) => setCustom(e.target.value)} rows={6} className="font-mono" />
          </Field>
        ) : null}
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </Field>
      </form>
    </Drawer>
  );
}

/* ============================ Regime definition =========================== */

function RuleTable({ rules, title }: { rules: WithholdingRule[]; title: string }) {
  if (rules.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-content-subtle">{title}</div>
      <ul className="space-y-1.5">
        {rules.map((r) => (
          <li key={r.key} className="rounded-md border border-border px-2.5 py-1.5 text-meta">
            <div className="flex items-center justify-between gap-2">
              <span className="text-content">{r.when}</span>
              <Badge tone="info" size="xs">
                {pct(r.rate)} on {titleCase(r.base)}
              </Badge>
            </div>
            <div className="mt-0.5 text-2xs text-content-subtle">
              {r.citation}
              {r.threshold ? ` · threshold ${count(r.threshold.amount)}: ${r.threshold.note}` : ""}
              {r.requires ? ` · requires ${titleCase(r.requires)}` : ""}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RegimeDrawer({ regime, onClose }: { regime: string | null; onClose: () => void }) {
  const def = useRegimeDef(regime);
  const d = def.data;
  return (
    <Drawer open={regime !== null} onClose={onClose} size="xl" icon={IconCompliance} title={d ? d.name : "Regime"} description={d ? `${d.jurisdiction} · rates as at ${isoDate(d.ratesAsAt)}` : undefined}>
      {def.loading && !d ? <LoadingBlock rows={6} /> : null}
      {def.error ? <LoadError message={def.error} onRetry={def.reload} /> : null}
      {d ? (
        <div className="space-y-5">
          <p className="text-meta text-content">{d.summary}</p>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">{d.indirectTax.name}</h3>
            <dl className="divide-y divide-border">
              <Row label="Standard rate">{d.indirectTax.kind === "none" ? "not applicable" : pct(d.indirectTax.standardRate)}</Row>
              <Row label="Citation">{d.indirectTax.citation}</Row>
              {d.indirectTax.registrationThreshold ? (
                <Row label="Registration threshold">
                  {money(d.indirectTax.registrationThreshold.amount, d.indirectTax.registrationThreshold.currency)} — {d.indirectTax.registrationThreshold.note}
                </Row>
              ) : null}
            </dl>
            {d.indirectTax.note ? <Alert tone="info" size="sm">{d.indirectTax.note}</Alert> : null}
            {d.indirectTax.otherRates.length > 0 ? (
              <ul className="space-y-1.5">
                {d.indirectTax.otherRates.map((r) => (
                  <li key={r.key} className="rounded-md border border-border px-2.5 py-1.5 text-meta">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        <span className="font-mono text-2xs text-content-subtle">{r.key}</span> · {r.appliesTo}
                      </span>
                      <Badge tone="accent" size="xs">
                        {titleCase(r.treatment)} {pct(r.rate)}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-2xs text-content-subtle">{r.citation}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">Reverse charge</h3>
            {d.reverseCharge.domesticConstruction ? (
              <div className="rounded-md border border-border p-3 text-meta">
                <div className="font-medium text-content">Domestic construction</div>
                <p className="mt-1 text-content-muted">{d.reverseCharge.domesticConstruction.summary}</p>
                <div className="mt-1 text-2xs text-content-subtle">
                  {d.reverseCharge.domesticConstruction.citation} · supplies: {d.reverseCharge.domesticConstruction.supplyTypes.map(titleCase).join(", ")} · contracts:{" "}
                  {d.reverseCharge.domesticConstruction.contractTypes.map(titleCase).join(", ")}
                  {d.reverseCharge.domesticConstruction.requiresCustomerVat ? " · customer must be VAT-registered" : ""}
                  {d.reverseCharge.domesticConstruction.requiresCustomerDeductionScheme ? " · customer must be inside the deduction scheme" : ""}
                  {d.reverseCharge.domesticConstruction.endUserExcluded ? " · end users excluded" : ""}
                </div>
              </div>
            ) : (
              <div className="text-meta text-content-subtle">No domestic reverse charge for construction.</div>
            )}
            {d.reverseCharge.importedServices ? (
              <div className="rounded-md border border-border p-3 text-meta">
                <div className="font-medium text-content">Imported services</div>
                <p className="mt-1 text-content-muted">{d.reverseCharge.importedServices.summary}</p>
                <div className="mt-1 text-2xs text-content-subtle">{d.reverseCharge.importedServices.citation}</div>
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">{d.withholding ? d.withholding.name : "Withholding"}</h3>
            {d.withholding ? (
              <>
                <p className="text-meta text-content-muted">{d.withholding.summary}</p>
                {d.withholding.registrationDriven ? (
                  <dl className="divide-y divide-border rounded-md border border-border px-3">
                    <Row label="Verified — gross status">{pct(d.withholding.registrationDriven.verifiedGrossRate)}</Row>
                    <Row label="Verified — net status">{pct(d.withholding.registrationDriven.verifiedNetRate)}</Row>
                    <Row label="Unmatched / unverified">{pct(d.withholding.registrationDriven.unverifiedRate)}</Row>
                    <Row label="Base">{titleCase(d.withholding.registrationDriven.base)}</Row>
                    <Row label="Citation">{d.withholding.registrationDriven.citation}</Row>
                  </dl>
                ) : null}
                <RuleTable rules={d.withholding.resident} title="Resident payees" />
                <RuleTable rules={d.withholding.nonResident} title="Non-resident payees" />
                <dl className="divide-y divide-border">
                  <Row label="Certificate">{d.withholding.certificateName}</Row>
                  <Row label="Remittance">{d.withholding.remittance}</Row>
                  <Row label="Verification validity">{d.withholding.verificationValidityDays ? `${d.withholding.verificationValidityDays} days` : "not time-limited"}</Row>
                </dl>
              </>
            ) : (
              <div className="text-meta text-content-subtle">No withholding or deduction scheme in this regime.</div>
            )}
          </section>

          {d.levies.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-content">Levies</h3>
              <ul className="space-y-1.5">
                {d.levies.map((l) => (
                  <li key={l.key} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-meta">
                    <span>
                      {l.name} <span className="text-2xs text-content-subtle">· {l.citation}</span>
                    </span>
                    <Badge tone={l.recoverable ? "neutral" : "warning"} size="xs">
                      {pct(l.rate)} {l.recoverable ? "" : "not recoverable"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">Returns</h3>
            {d.returns.length === 0 ? (
              <div className="text-meta text-content-subtle">No return cadence in the library — periods need explicit dates.</div>
            ) : (
              <ul className="space-y-1.5">
                {d.returns.map((r) => (
                  <li key={r.kind} className="rounded-md border border-border px-2.5 py-1.5 text-meta">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-content">{r.name}</span>
                      <Badge tone="neutral" size="xs">
                        {titleCase(r.cadence)} · due {r.dueDaysAfterPeriodEnd}d after period end
                        {r.paymentDueDaysAfterPeriodEnd !== null ? ` · pay ${r.paymentDueDaysAfterPeriodEnd}d` : ""}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-2xs text-content-subtle">
                      {r.citation}
                      {r.note ? ` · ${r.note}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">Permanent establishment</h3>
            <dl className="divide-y divide-border">
              <Row label="Building site threshold">{d.permanentEstablishment.constructionSiteDays} days</Row>
              <Row label="Individual presence threshold">{d.permanentEstablishment.serviceDays} days</Row>
              <Row label="Citation">{d.permanentEstablishment.citation}</Row>
            </dl>
            <p className="text-meta text-content-muted">{d.permanentEstablishment.basis}</p>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-content">Tax invoice requirements</h3>
            <ReasonList reasons={d.invoiceRequirements} />
            {d.eInvoicing ? <Alert tone="info" size="sm" title="E-invoicing">{d.eInvoicing}</Alert> : null}
          </section>

          {d.notes.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-content">Notes and deliberate simplifications</h3>
              <ReasonList reasons={d.notes} />
            </section>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
