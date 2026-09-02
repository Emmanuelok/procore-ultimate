/**
 * Certificates (#780-781) — evidence about somebody else's cover.
 *
 * A certificate is Evidence, and the policy record is the Assertion it tests
 * (ADR 0004). Two consequences run through this tab and are never hidden:
 *
 *  · the actor who submits a certificate may not also verify it — the API
 *    refuses with 403 unless the caller holds an integrity_reviewer grant, and
 *    a verification taken under that override is not independent;
 *  · a certificate filed by the same actor who authored the policy it
 *    evidences comes back `selfEvidenced: true` at filing, and that shows as a
 *    visible caveat rather than as metadata nobody reads.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { POLICY_TYPES } from "@constructos/shared";
import { api } from "../../lib/api";
import {
  Badge,
  Button,
  Card,
  CardBody,
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
import { formatDate } from "../format";
import CertificateDrawer from "./CertificateDrawer";
import {
  CERTIFICATE_STATUSES,
  Caveat,
  DeadlineChip,
  Pager,
  certificateTone,
  errMsg,
  fmtMoney,
  policyTypeLabel,
  type CertificateCreated,
  type CertificateRow,
  type FocusRequest,
  type ListResponse,
  type PolicyRow,
  type VendorLite,
} from "./insuranceShared";

const PAGE_SIZE = 25;

export default function CertificatesTab({
  projectId,
  focus,
}: {
  projectId: string;
  focus: FocusRequest | null;
}) {
  const base = `/api/v1/projects/${projectId}`;

  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [verifiedFilter, setVerifiedFilter] = useState("");
  const [inDateOnly, setInDateOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [items, setItems] = useState<CertificateRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [vendors, setVendors] = useState<VendorLite[]>([]);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /**
   * `selfEvidenced` is reported once, in the create response — it is not a
   * stored column and is not re-derived on later reads. Everything filed in
   * this session that came back flagged is remembered here so the caveat is
   * visible where the record is, and the drawer says plainly that this is a
   * session-scoped observation rather than a field on the row.
   */
  const [selfEvidenced, setSelfEvidenced] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (typeFilter) params.set("policyType", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (vendorFilter) params.set("vendorId", vendorFilter);
      if (verifiedFilter) params.set("verified", verifiedFilter);
      const res = await api.get<ListResponse<CertificateRow>>(
        `${base}/insurance/certificates?${params}`,
      );
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      setItems([]);
      setError(errMsg(err, "Failed to load certificates"));
    }
  }, [base, page, statusFilter, typeFilter, vendorFilter, verifiedFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [v, p] = await Promise.all([
          api.get<ListResponse<VendorLite>>("/api/v1/vendors?pageSize=200"),
          api.get<ListResponse<PolicyRow>>(`${base}/insurance/policies?pageSize=200`),
        ]);
        if (cancelled) return;
        setVendors(v.items);
        setPolicies(p.items);
      } catch {
        // pickers degrade to "none"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base]);

  /* The radar sends the reader here either at a certificate or at a vendor. */
  useEffect(() => {
    if (!focus) return;
    if (focus.vendorId) {
      setVendorFilter(focus.vendorId);
      setVerifiedFilter("");
      setStatusFilter("");
      setPage(1);
    }
    if (focus.recordId) setSelectedId(focus.recordId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /* -------------------------------- create -------------------------------- */

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cSubject, setCSubject] = useState("");
  const [cType, setCType] = useState<string>("third_party_liability");
  const [cVendorId, setCVendorId] = useState("");
  const [cPolicyId, setCPolicyId] = useState("");
  const [cNumber, setCNumber] = useState("");
  const [cInsurer, setCInsurer] = useState("");
  const [cLimit, setCLimit] = useState("");
  const [cCurrency, setCCurrency] = useState("GBP");
  const [cFrom, setCFrom] = useState("");
  const [cTo, setCTo] = useState("");
  const [lastFiled, setLastFiled] = useState<CertificateCreated | null>(null);

  function openCreate() {
    setCreateError(null);
    setCSubject("");
    setCType("third_party_liability");
    setCVendorId(vendorFilter);
    setCPolicyId("");
    setCNumber("");
    setCInsurer("");
    setCLimit("");
    setCCurrency("GBP");
    setCFrom("");
    setCTo("");
    setCreateOpen(true);
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        subjectName: cSubject.trim(),
        policyType: cType,
        validFrom: cFrom,
        validTo: cTo,
        currency: cCurrency.trim().toUpperCase() || "GBP",
        vendorId: cVendorId || null,
        policyId: cPolicyId || null,
        certificateNumber: cNumber.trim() || null,
        insurer: cInsurer.trim() || null,
        limitOfIndemnity: cLimit === "" ? null : Number(cLimit),
      };
      const created = await api.post<CertificateCreated>(
        `${base}/insurance/certificates`,
        payload,
      );
      setLastFiled(created);
      if (created.selfEvidenced) {
        setSelfEvidenced((prev) => ({ ...prev, [created.id]: true }));
      }
      setCreateOpen(false);
      setPage(1);
      await load();
      setSelectedId(created.id);
    } catch (err) {
      setCreateError(errMsg(err, "Failed to file the certificate"));
    } finally {
      setBusy(false);
    }
  }

  const visible = items === null ? null : inDateOnly ? items.filter((c) => c.inDate) : items;
  const selectedPolicy = policies.find((p) => p.id === cPolicyId) ?? null;
  const typeMismatch = selectedPolicy !== null && selectedPolicy.policyType !== cType;

  return (
    <div>
      {/* -------------------------------- filters -------------------------------- */}
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-end gap-3 py-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Policy type</span>
            <Select
              value={typeFilter}
              onChange={(e) => {
                setTypeFilter(e.target.value);
                setPage(1);
              }}
              className="w-52"
            >
              <option value="">All types</option>
              {POLICY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {policyTypeLabel(t)}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Vendor</span>
            <Select
              value={vendorFilter}
              onChange={(e) => {
                setVendorFilter(e.target.value);
                setPage(1);
              }}
              className="w-52"
            >
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Status</span>
            <Select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">All</option>
              {CERTIFICATE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-600">Verification</span>
            <Select
              value={verifiedFilter}
              onChange={(e) => {
                setVerifiedFilter(e.target.value);
                setPage(1);
              }}
              className="w-44"
            >
              <option value="">All</option>
              <option value="true">Verified</option>
              <option value="false">Not verified</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={inDateOnly}
              onChange={(e) => setInDateOnly(e.target.checked)}
            />
            In date only
            <span
              className="cursor-help rounded-full border border-ink-200 px-1 text-[9px] leading-4 text-ink-400"
              title="In-date is derived by the API per certificate, not a server-side filter — this checkbox filters the page you are looking at, so the count below still reports the unfiltered total."
            >
              ?
            </span>
          </label>
          <div className="grow" />
          <Button onClick={openCreate}>File certificate</Button>
        </CardBody>
      </Card>

      {lastFiled?.selfEvidenced ? (
        <div className="mb-3">
          <Caveat>
            <strong>Self-evidenced.</strong> The certificate you just filed for{" "}
            {lastFiled.subjectName} was submitted by the same actor who authored the policy it
            evidences, and the API returned{" "}
            <code className="text-[11px]">selfEvidenced: true</code>. Collection is administrative
            so it was not blocked, but this is not independent evidence, and verifying it yourself
            will be refused.
          </Caveat>
        </div>
      ) : null}

      <ErrorAlert message={error} />

      {visible === null ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <EmptyState
          title={
            items && items.length > 0
              ? "Nothing on this page is in date"
              : "No certificates in this scope"
          }
          hint="Collect evidence of cover from the party that must carry it. A certificate is a summary written for the insured — it is evidence, not the policy."
          action={<Button onClick={openCreate}>File the first certificate</Button>}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Subject</Th>
                <Th>Type</Th>
                <Th>Insurer / cert no.</Th>
                <Th className="text-right">Limit</Th>
                <Th>Validity</Th>
                <Th>Expiry</Th>
                <Th>Verification</Th>
                <Th>File</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {visible.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-ink-50/60"
                  onClick={() => setSelectedId(c.id)}
                >
                  <Td>
                    <div className="text-sm font-medium text-ink-900">{c.subjectName}</div>
                    {selfEvidenced[c.id] ? (
                      <span
                        className="mt-0.5 inline-flex rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900"
                        title="Reported selfEvidenced:true when it was filed in this session — the actor who filed it also authored the policy it evidences."
                      >
                        self-evidenced
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">{policyTypeLabel(c.policyType)}</Td>
                  <Td>
                    <div className="text-sm text-ink-800">{c.insurer ?? "—"}</div>
                    <div className="font-mono text-[11px] text-ink-400">
                      {c.certificateNumber ?? ""}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    {c.limitOfIndemnity === null ? (
                      <span className="text-xs text-ink-400">not recorded</span>
                    ) : (
                      fmtMoney(c.limitOfIndemnity, c.currency, 0)
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {formatDate(c.validFrom)} → {formatDate(c.validTo)}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <DeadlineChip days={c.daysToExpiry} />
                  </Td>
                  <Td className="whitespace-nowrap">
                    {c.verified ? (
                      <span title={`Method: ${c.verificationMethod ?? "not recorded"}`}>
                        <Badge tone="green">verified</Badge>
                      </span>
                    ) : (
                      <Badge tone="amber">unverified</Badge>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {c.fileSha256 ? (
                      <span
                        className="font-mono text-[11px] text-ink-500"
                        title={`sha256 ${c.fileSha256}`}
                      >
                        {c.fileSha256.slice(0, 10)}…
                      </span>
                    ) : (
                      <span className="text-xs text-ink-400">none</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    <Badge tone={certificateTone(c)}>
                      {c.status === "active" ? (c.inDate ? "in date" : "expired") : c.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pager
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
            noun="certificate"
            onPage={setPage}
          />
          {inDateOnly && items && visible.length !== items.length ? (
            <p className="mt-2 text-xs text-ink-500">
              Showing {visible.length} of the {items.length} certificate(s) on this page that are in
              date. The total above counts every certificate matching the server-side filters.
            </p>
          ) : null}
        </>
      )}

      {/* ------------------------------ create modal ------------------------------ */}
      <Modal open={createOpen} title="File a certificate" onClose={() => setCreateOpen(false)} wide>
        <ErrorAlert message={createError} />
        <form onSubmit={onCreate} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Subject" hint="The party whose cover this evidences, as written on the certificate.">
              <Input
                required
                value={cSubject}
                onChange={(e) => setCSubject(e.target.value)}
                placeholder="Sub-contractor Ltd"
              />
            </Field>
            <Field label="Vendor" hint="Linking the vendor is what lets the cover-gap analysis see this evidence.">
              <Select value={cVendorId} onChange={(e) => setCVendorId(e.target.value)}>
                <option value="">Not linked</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Policy type">
              <Select value={cType} onChange={(e) => setCType(e.target.value)}>
                {POLICY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {policyTypeLabel(t)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Evidences policy" hint="Optional — the policy record this certificate is evidence about.">
              <Select value={cPolicyId} onChange={(e) => setCPolicyId(e.target.value)}>
                <option value="">Not linked</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.number} · {policyTypeLabel(p.policyType)} · {p.insurer}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {typeMismatch ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200">
              The certificate type ({policyTypeLabel(cType)}) does not match the linked policy's
              type ({policyTypeLabel(selectedPolicy?.policyType ?? "")}). The API will refuse this.
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Field label="Insurer">
              <Input value={cInsurer} onChange={(e) => setCInsurer(e.target.value)} />
            </Field>
            <Field label="Certificate number">
              <Input value={cNumber} onChange={(e) => setCNumber(e.target.value)} />
            </Field>
            <Field label="Limit of indemnity">
              <Input
                type="number"
                min={0}
                step="any"
                value={cLimit}
                onChange={(e) => setCLimit(e.target.value)}
              />
            </Field>
            <Field label="Currency">
              <Input
                value={cCurrency}
                maxLength={3}
                onChange={(e) => setCCurrency(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Valid from">
              <Input
                type="date"
                required
                value={cFrom}
                onChange={(e) => setCFrom(e.target.value)}
              />
            </Field>
            <Field label="Valid to">
              <Input type="date" required value={cTo} onChange={(e) => setCTo(e.target.value)} />
            </Field>
          </div>

          <Caveat>
            Filing is administrative and is never blocked, but the API records who filed it. If you
            authored the policy this evidences, the response will come back{" "}
            <code className="text-[11px]">selfEvidenced: true</code> and you will not be able to
            verify it yourself.
          </Caveat>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Filing…" : "File certificate"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* --------------------------------- drawer --------------------------------- */}
      {selectedId ? (
        <CertificateDrawer
          projectId={projectId}
          certificateId={selectedId}
          selfEvidenced={selfEvidenced[selectedId] === true}
          vendors={vendors}
          onClose={() => setSelectedId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
