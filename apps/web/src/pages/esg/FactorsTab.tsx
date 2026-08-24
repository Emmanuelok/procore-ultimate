/**
 * Carbon factor library — spec Vol II Domain I (#496-498).
 *
 * The library is tenant reference data, not project data: every entry in
 * every project's register points back to a row here, which is why a factor
 * already in use cannot be edited. Product-specific EPDs are flagged
 * distinctly from generic library averages, because the difference is what
 * makes a footprint defensible.
 */
import { useMemo, useState, type FormEvent } from "react";
import { CARBON_FACTOR_SOURCES } from "@constructos/shared";
import { api, ApiClientError } from "../../lib/api";
import {
  Badge,
  Button,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  Caveat,
  EpdBadge,
  FACTOR_SOURCE_LABELS,
  factorSourceTone,
  fmtNum,
  type FactorRow,
  type SeedResult,
} from "./esgShared";

const SEED_CAVEAT =
  "Seeded factors are indicative published-order values, not a licensed dataset. They exist so " +
  "the register can be stood up and the arithmetic exercised on day one. They are not version-" +
  "controlled against any published edition of ICE or DEFRA, not specific to any supplier, mix " +
  "design, recycled content or region, and not a substitute for an EPD where one exists. " +
  "Replace them with a verified dataset or product EPDs before any contractual, tender or " +
  "disclosure reporting.";

export default function FactorsTab({
  factors,
  error,
  onReload,
}: {
  factors: FactorRow[] | null;
  error: string | null;
  onReload: () => Promise<void>;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (factors ?? []).filter((f) => {
      if (sourceFilter && f.source !== sourceFilter) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        (f.materialCategory ?? "").toLowerCase().includes(q) ||
        (f.epdReference ?? "").toLowerCase().includes(q)
      );
    });
  }, [factors, search, sourceFilter]);

  const productSpecificCount = (factors ?? []).filter((f) => f.isProductSpecific === 1).length;

  /* -------------------------------- seeding ------------------------------- */

  const [seedResult, setSeedResult] = useState<SeedResult | null>(null);

  async function onSeed() {
    if (
      !window.confirm(
        "Seed the starter factor set?\n\nThese are indicative published-order values, not a " +
          "licensed dataset. They must be replaced with a verified dataset or product EPDs " +
          "before contractual reporting.",
      )
    ) {
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      const res = await api.post<SeedResult>("/api/v1/carbon-factors/seed-defaults");
      setSeedResult(res);
      await onReload();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Failed to seed the factor library");
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------ create modal ---------------------------- */

  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fUnit, setFUnit] = useState("kg");
  const [fValue, setFValue] = useState("");
  const [fSource, setFSource] = useState<string>("epd");
  const [fProductSpecific, setFProductSpecific] = useState(true);
  const [fEpdRef, setFEpdRef] = useState("");
  const [fValidUntil, setFValidUntil] = useState("");

  function openCreate() {
    setFormError(null);
    setFName("");
    setFCategory("");
    setFUnit("kg");
    setFValue("");
    setFSource("epd");
    setFProductSpecific(true);
    setFEpdRef("");
    setFValidUntil("");
    setOpen(true);
  }

  function pickSource(src: string) {
    setFSource(src);
    // A generic library average is by definition not product-specific; an EPD
    // is. The user can still override, but the default should be honest.
    if (src === "epd") setFProductSpecific(true);
    if (src === "ice_database" || src === "generic") setFProductSpecific(false);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: fName.trim(),
        unit: fUnit.trim(),
        factorKgCo2ePerUnit: Number(fValue),
        source: fSource,
        isProductSpecific: fProductSpecific,
      };
      if (fCategory.trim()) payload["materialCategory"] = fCategory.trim();
      if (fEpdRef.trim()) payload["epdReference"] = fEpdRef.trim();
      if (fValidUntil) payload["validUntil"] = fValidUntil;
      await api.post<FactorRow>("/api/v1/carbon-factors", payload);
      setOpen(false);
      await onReload();
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : "Failed to create the factor.");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(f: FactorRow) {
    if (!window.confirm(`Delete the factor "${f.name}"?`)) return;
    setLocalError(null);
    try {
      await api.del(`/api/v1/carbon-factors/${f.id}`);
      await onReload();
    } catch (err) {
      // A factor already referenced by entries is immutable — the API says so
      // with a 409, and that message is the useful one to surface.
      setLocalError(err instanceof Error ? err.message : "Failed to delete the factor");
    }
  }

  /* -------------------------------- render -------------------------------- */

  return (
    <div>
      <ErrorAlert message={error ?? localError} />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Material, category or EPD reference"
              className="w-64"
            />
          </Field>
          <Field label="Source">
            <Select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="w-44"
            >
              <option value="">All sources</option>
              {CARBON_FACTOR_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {FACTOR_SOURCE_LABELS[s] ?? humanize(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void onSeed()} disabled={busy}>
            {busy ? "Working…" : "Seed default factors"}
          </Button>
          <Button onClick={openCreate}>New factor</Button>
        </div>
      </div>

      <div className="mb-3">
        <Caveat>
          <strong>Seeding adds indicative values, not a verified dataset.</strong> The starter set
          exists so the register can be stood up and the arithmetic exercised on day one. It is
          not version-controlled against any published edition of ICE or DEFRA, and is not
          specific to a supplier, mix design, recycled content or region. Replace it with a
          licensed dataset or product EPDs before any contractual, tender or disclosure reporting.
        </Caveat>
      </div>

      {seedResult ? (
        <div className="mb-3 rounded-md bg-brand-50 px-3 py-2.5 text-sm text-brand-900 ring-1 ring-brand-100">
          <div className="font-semibold">
            {seedResult.created} factor{seedResult.created === 1 ? "" : "s"} added
            {seedResult.skipped > 0
              ? `, ${seedResult.skipped} already present`
              : ""}{" "}
            <span className="font-normal text-brand-800/70">
              (starter set of {seedResult.total})
            </span>
          </div>
          <p className="mt-0.5 text-xs text-brand-800/80">{seedResult.warning}</p>
        </div>
      ) : null}

      {factors === null ? (
        <Spinner label="Loading factor library…" />
      ) : factors.length === 0 ? (
        <EmptyState
          title="The factor library is empty"
          hint="Every carbon entry points at a factor in this library, so the register can always say where a number came from. Seed the indicative starter set to get moving, then replace it with your verified dataset and supplier EPDs."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="secondary" onClick={() => void onSeed()} disabled={busy}>
                Seed default factors
              </Button>
              <Button onClick={openCreate}>Add a factor</Button>
            </div>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No factors match"
          hint="Clear the search or the source filter to see the whole library."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                setSearch("");
                setSourceFilter("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <p className="mb-2 text-xs text-ink-400">
            {visible.length} of {factors.length} factor{factors.length === 1 ? "" : "s"} ·{" "}
            <span className={productSpecificCount > 0 ? "text-emerald-700" : undefined}>
              {productSpecificCount} product-specific
            </span>
          </p>
          <Table>
            <thead>
              <tr>
                <Th>Factor</Th>
                <Th>Category</Th>
                <Th>Unit</Th>
                <Th className="text-right">kgCO₂e / unit</Th>
                <Th>Source</Th>
                <Th>Valid to</Th>
                <Th />
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {visible.map((f) => (
                <tr key={f.id} className="hover:bg-ink-50/60">
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-ink-900">{f.name}</span>
                      <EpdBadge
                        isProductSpecific={f.isProductSpecific === 1}
                        reference={f.epdReference}
                      />
                    </div>
                    {f.epdReference ? (
                      <div className="font-mono text-[11px] text-ink-400">{f.epdReference}</div>
                    ) : null}
                  </Td>
                  <Td className="text-xs text-ink-600">
                    {f.materialCategory ? humanize(f.materialCategory) : "—"}
                  </Td>
                  <Td className="text-xs text-ink-600">{f.unit}</Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums text-ink-900">
                    {fmtNum(f.factorKgCo2ePerUnit, 4)}
                  </Td>
                  <Td>
                    <Badge tone={factorSourceTone(f.source)}>
                      {FACTOR_SOURCE_LABELS[f.source] ?? humanize(f.source)}
                    </Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-ink-500">
                    {f.validUntil ? formatDate(f.validUntil) : "—"}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onDelete(f)}
                      aria-label={`Delete factor ${f.name}`}
                      title="Delete. A factor already referenced by carbon entries cannot be removed — supersede it instead."
                    >
                      ✕
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}

      {/* ------------------------------ create modal --------------------------- */}
      <Modal open={open} title="New carbon factor" onClose={() => setOpen(false)} wide>
        <ErrorAlert message={formError} />
        <form onSubmit={onCreate} className="space-y-4">
          <Field label="Name">
            <Input
              required
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="CEM III/A concrete C32/40, 50% GGBS — Supplier X mix 4821"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Material category">
              <Input
                value={fCategory}
                onChange={(e) => setFCategory(e.target.value)}
                placeholder="concrete"
              />
            </Field>
            <Field label="Unit" hint="The unit the factor is published per.">
              <Input
                required
                value={fUnit}
                onChange={(e) => setFUnit(e.target.value)}
                placeholder="kg"
              />
            </Field>
            <Field label="kgCO₂e per unit">
              <Input
                type="number"
                min="0.000001"
                step="any"
                required
                value={fValue}
                onChange={(e) => setFValue(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Source">
              <Select value={fSource} onChange={(e) => pickSource(e.target.value)}>
                {CARBON_FACTOR_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {FACTOR_SOURCE_LABELS[s] ?? humanize(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Valid until" hint="EPDs expire — after this date the figure is stale.">
              <Input
                type="date"
                value={fValidUntil}
                onChange={(e) => setFValidUntil(e.target.value)}
              />
            </Field>
          </div>

          <Field label="EPD reference" hint="Declaration number of the Environmental Product Declaration.">
            <Input
              value={fEpdRef}
              onChange={(e) => setFEpdRef(e.target.value)}
              placeholder="EPD-XYZ-20240117-CBD1-EN"
              className="font-mono"
            />
          </Field>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md bg-ink-50 px-3 py-2.5 ring-1 ring-ink-100">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
              checked={fProductSpecific}
              onChange={(e) => setFProductSpecific(e.target.checked)}
            />
            <span className="text-sm text-ink-700">
              <span className="font-medium text-ink-900">Product-specific</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">
                A declared value for this actual product, from a verified EPD — not a generic
                average for the material class. Only product-specific factors count towards the
                register's data-quality share, so flagging a generic figure as product-specific
                overstates the assessment's maturity.
              </span>
            </span>
          </label>

          {fProductSpecific && !fEpdRef.trim() ? (
            <p className="text-xs font-medium text-amber-700">
              Product-specific without a declaration reference — record the EPD number so the
              figure can be traced back to the declaration it came from.
            </p>
          ) : null}

          <p className="text-xs leading-relaxed text-ink-400">{SEED_CAVEAT}</p>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create factor"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
