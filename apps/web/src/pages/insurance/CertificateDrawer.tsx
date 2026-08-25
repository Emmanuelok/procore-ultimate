/**
 * Certificate detail — the evidence, the file behind it, and who says it is real.
 *
 * The verification block is deliberately the least reassuring thing on the
 * page. A green tick here means a colleague recorded that they checked
 * something; `verificationStrength` is the API's own account of how much that
 * is worth, and it is printed verbatim next to the tick every time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { POLICY_TYPES } from "@constructos/shared";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  ErrorAlert,
  Field,
  Input,
  Select,
  Spinner,
} from "../../ui";
import { formatDate, formatDateTime } from "../format";
import {
  CERTIFICATE_STATUSES,
  Caveat,
  ConfirmStrip,
  DeadlineChip,
  DetailRow,
  Disclosure,
  Drawer,
  SectionTitle,
  VERIFICATION_METHODS,
  VERIFICATION_METHOD_DESCRIPTIONS,
  VERIFICATION_METHOD_LABELS,
  certificateTone,
  errMsg,
  fmtBytes,
  fmtMoney,
  policyTypeLabel,
  todayIso,
  type CertificateFileMeta,
  type CertificateFiled,
  type CertificateRow,
  type CertificateVerified,
  type VendorLite,
} from "./insuranceShared";

const SUBSTANTIVE = ["validFrom", "validTo", "limitOfIndemnity", "insurer", "policyType"] as const;

export default function CertificateDrawer({
  projectId,
  certificateId,
  selfEvidenced,
  vendors,
  onClose,
  onChanged,
}: {
  projectId: string;
  certificateId: string;
  selfEvidenced: boolean;
  vendors: VendorLite[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const base = `/api/v1/projects/${projectId}/insurance/certificates/${certificateId}`;

  const [cert, setCert] = useState<CertificateRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setCert(await api.get<CertificateRow>(base));
    } catch (err) {
      setCert(null);
      setError(errMsg(err, "Failed to load the certificate"));
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------ verification ------------------------------ */

  const [method, setMethod] = useState<string>("broker_confirmation");
  const [reference, setReference] = useState("");
  const [verifiedAt, setVerifiedAt] = useState(todayIso());
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyRefused, setVerifyRefused] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<CertificateVerified | null>(null);

  async function onVerify() {
    setBusy(true);
    setVerifyError(null);
    setVerifyRefused(null);
    try {
      const body: Record<string, unknown> = { verificationMethod: method };
      if (reference.trim()) body["reference"] = reference.trim();
      if (verifiedAt) body["verifiedAt"] = verifiedAt;
      const res = await api.post<CertificateVerified>(`${base}/verify`, body);
      setVerifyResult(res);
      setCert(res);
      onChanged();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setVerifyRefused(err.message);
      } else {
        setVerifyError(errMsg(err, "Verification failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------- file --------------------------------- */

  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<CertificateFileMeta | null>(null);

  async function onUpload() {
    const f = fileInput.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setFileError(null);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await api.upload<CertificateFiled>(`${base}/file`, form);
      setUploaded(res.file);
      setCert(res);
      if (fileInput.current) fileInput.current.value = "";
      onChanged();
    } catch (err) {
      setFileError(errMsg(err, "Upload failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onDownload() {
    if (!cert?.fileId) return;
    setFileError(null);
    try {
      const url = await fetchBlobUrl(`${base}/file`);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${cert.subjectName}-${cert.policyType}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setFileError(errMsg(err, "Download failed"));
    }
  }

  /* --------------------------------- edit --------------------------------- */

  const [editOpen, setEditOpen] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [edit, setEdit] = useState({
    subjectName: "",
    policyType: "",
    certificateNumber: "",
    insurer: "",
    limitOfIndemnity: "",
    currency: "",
    validFrom: "",
    validTo: "",
    vendorId: "",
    status: "",
  });

  function openEdit() {
    if (!cert) return;
    setEdit({
      subjectName: cert.subjectName,
      policyType: cert.policyType,
      certificateNumber: cert.certificateNumber ?? "",
      insurer: cert.insurer ?? "",
      limitOfIndemnity: cert.limitOfIndemnity === null ? "" : String(cert.limitOfIndemnity),
      currency: cert.currency,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      vendorId: cert.vendorId ?? "",
      status: cert.status,
    });
    setAck(false);
    setEditError(null);
    setEditOpen(true);
  }

  /** Only changed fields are sent: the API clears verification on the mere
   * PRESENCE of a substantive key, not on a changed value. */
  function changedPayload(): Record<string, unknown> {
    if (!cert) return {};
    const out: Record<string, unknown> = {};
    if (edit.subjectName.trim() !== cert.subjectName) out["subjectName"] = edit.subjectName.trim();
    if (edit.policyType !== cert.policyType) out["policyType"] = edit.policyType;
    if ((edit.certificateNumber.trim() || null) !== cert.certificateNumber)
      out["certificateNumber"] = edit.certificateNumber.trim() || null;
    if ((edit.insurer.trim() || null) !== cert.insurer) out["insurer"] = edit.insurer.trim() || null;
    const limit = edit.limitOfIndemnity === "" ? null : Number(edit.limitOfIndemnity);
    if (limit !== cert.limitOfIndemnity) out["limitOfIndemnity"] = limit;
    if (edit.currency.trim().toUpperCase() !== cert.currency)
      out["currency"] = edit.currency.trim().toUpperCase();
    if (edit.validFrom !== cert.validFrom) out["validFrom"] = edit.validFrom;
    if (edit.validTo !== cert.validTo) out["validTo"] = edit.validTo;
    if ((edit.vendorId || null) !== cert.vendorId) out["vendorId"] = edit.vendorId || null;
    if (edit.status !== cert.status) out["status"] = edit.status;
    return out;
  }

  const payload = editOpen ? changedPayload() : {};
  const touchesSubstance = Object.keys(payload).some((k) =>
    (SUBSTANTIVE as readonly string[]).includes(k),
  );
  const willClearVerification = touchesSubstance && cert?.verified === true;

  async function onSaveEdit() {
    if (!cert) return;
    const body = changedPayload();
    if (Object.keys(body).length === 0) {
      setEditOpen(false);
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      const updated = await api.patch<CertificateRow>(base, body);
      setCert(updated);
      setVerifyResult(null);
      setEditOpen(false);
      onChanged();
    } catch (err) {
      setEditError(errMsg(err, "Failed to save the certificate"));
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- delete -------------------------------- */

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDelete() {
    setBusy(true);
    setDeleteError(null);
    try {
      await api.del(base);
      onChanged();
      onClose();
    } catch (err) {
      setConfirmDelete(false);
      setDeleteError(errMsg(err, "The certificate could not be deleted"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={
        cert ? (
          <span className="flex flex-wrap items-center gap-2">
            <span>{cert.subjectName}</span>
            <span className="text-sm font-normal text-ink-500">
              {policyTypeLabel(cert.policyType)}
            </span>
            <Badge tone={certificateTone(cert)}>{cert.inDate ? "in date" : "not in date"}</Badge>
            {cert.verified ? <Badge tone="green">verified</Badge> : <Badge tone="amber">unverified</Badge>}
          </span>
        ) : (
          "Certificate"
        )
      }
    >
      <ErrorAlert message={error} />
      {cert === null ? (
        error ? null : (
          <Spinner />
        )
      ) : (
        <div>
          {selfEvidenced ? (
            <div className="mb-3">
              <Caveat>
                <strong>Self-evidenced.</strong> When this certificate was filed the API returned{" "}
                <code className="text-[11px]">selfEvidenced: true</code> — it was submitted by the
                same actor who authored the policy it evidences. That flag is reported at filing
                and is not a stored column, so it is shown here only for records filed in this
                browser session; it does not disappear because a later read does not repeat it.
              </Caveat>
            </div>
          ) : null}

          <SectionTitle>Evidence</SectionTitle>
          <div>
            <DetailRow label="Policy type">{policyTypeLabel(cert.policyType)}</DetailRow>
            <DetailRow label="Insurer">{cert.insurer ?? <span className="text-ink-400">Not recorded</span>}</DetailRow>
            <DetailRow label="Certificate no.">
              {cert.certificateNumber ?? <span className="text-ink-400">Not recorded</span>}
            </DetailRow>
            <DetailRow label="Limit">
              {cert.limitOfIndemnity === null ? (
                <span className="text-ink-400">Not recorded</span>
              ) : (
                fmtMoney(cert.limitOfIndemnity, cert.currency, 0)
              )}
            </DetailRow>
            <DetailRow label="Validity">
              {formatDate(cert.validFrom)} → {formatDate(cert.validTo)}{" "}
              <DeadlineChip days={cert.daysToExpiry} />
            </DetailRow>
            <DetailRow label="In date">
              {cert.inDate ? "Yes" : "No — this is not evidence of cover in force today"}
            </DetailRow>
            <DetailRow label="Vendor">
              {cert.vendorId ? (
                (vendors.find((v) => v.id === cert.vendorId)?.name ?? cert.vendorId)
              ) : (
                <span className="text-amber-700">
                  Not linked — cover-gap analysis cannot see this certificate
                </span>
              )}
            </DetailRow>
            <DetailRow label="Status">{cert.status}</DetailRow>
          </div>

          {/* ------------------------------ verification ------------------------------ */}
          <SectionTitle hint="Evidence is verified by somebody other than the party who submitted it. That is the whole point of the step.">
            Verification
          </SectionTitle>

          {cert.verified ? (
            <div className="space-y-2">
              <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
                Verified {formatDateTime(cert.verifiedAt)} · method{" "}
                <strong>
                  {VERIFICATION_METHOD_LABELS[cert.verificationMethod ?? ""] ??
                    cert.verificationMethod ??
                    "not recorded"}
                </strong>
              </div>
              {verifyResult ? (
                <>
                  <Disclosure
                    label="verificationStrength — returned verbatim by the API"
                    tone={verifyResult.independentVerification ? "brand" : "red"}
                  >
                    {verifyResult.verificationStrength}
                  </Disclosure>
                  {verifyResult.independentVerification ? null : (
                    <Disclosure label="independentVerification: false" tone="red">
                      This certificate was verified by the actor who submitted it, under an
                      integrity_reviewer override. The API flagged the verification{" "}
                      <code className="text-[11px]">selfVerifiedUnderOverride</code> and ledgered
                      it. It is a record that somebody knowingly self-verified — not independent
                      confirmation that the cover exists.
                    </Disclosure>
                  )}
                </>
              ) : (
                <Caveat>
                  This certificate was verified in an earlier session, so the API's{" "}
                  <code className="text-[11px]">verificationStrength</code> and{" "}
                  <code className="text-[11px]">independentVerification</code> for that act are not
                  in this response — only the stored method is. On the method recorded:{" "}
                  {VERIFICATION_METHOD_DESCRIPTIONS[cert.verificationMethod ?? ""] ??
                    "no description is available for the recorded method."}
                </Caveat>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Caveat>
                The actor who submitted a certificate cannot also verify it (ADR 0004). If you filed
                this one, the API will refuse with 403 unless you hold an{" "}
                <code className="text-[11px]">integrity_reviewer</code> grant — in which case it
                succeeds, flagged <code className="text-[11px]">selfVerifiedUnderOverride</code>,
                and is not independent verification.
              </Caveat>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Method">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {VERIFICATION_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {VERIFICATION_METHOD_LABELS[m] ?? m}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference" hint="Call reference, email, portal record.">
                  <Input value={reference} onChange={(e) => setReference(e.target.value)} />
                </Field>
                <Field label="Verified at">
                  <Input
                    type="date"
                    value={verifiedAt}
                    onChange={(e) => setVerifiedAt(e.target.value)}
                  />
                </Field>
              </div>
              <p className="text-xs leading-relaxed text-ink-600">
                {VERIFICATION_METHOD_DESCRIPTIONS[method] ?? ""}
              </p>
              <ErrorAlert message={verifyError} />
              {verifyRefused ? (
                <div className="rounded-md border-l-4 border-red-700 bg-red-900 px-3 py-2 text-xs leading-relaxed text-red-50">
                  <div className="font-bold uppercase tracking-wide">Verification refused (403)</div>
                  <p className="mt-1">{verifyRefused}</p>
                </div>
              ) : null}
              <Button disabled={busy} onClick={() => void onVerify()}>
                {busy ? "Working…" : "Record verification"}
              </Button>
            </div>
          )}

          {/* --------------------------------- file --------------------------------- */}
          <SectionTitle hint="The certificate document itself, stored content-addressed.">
            File
          </SectionTitle>
          <ErrorAlert message={fileError} />
          {uploaded ? (
            <div className="mb-2 rounded-md bg-brand-50 px-3 py-2 text-xs text-brand-900 ring-1 ring-brand-100">
              Stored <strong>{uploaded.name}</strong> · {fmtBytes(uploaded.sizeBytes)} ·{" "}
              {uploaded.contentType}
              <div className="mt-1 break-all font-mono text-[11px]">sha256 {uploaded.sha256}</div>
              <div className="mt-1">
                That digest is what makes the stored document checkable later: a file whose content
                changes cannot keep this hash.
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {cert.fileId ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => void onDownload()}>
                  Download
                </Button>
                <span className="break-all font-mono text-[11px] text-ink-500">
                  sha256 {cert.fileSha256 ?? "not recorded"}
                </span>
              </>
            ) : (
              <span className="text-sm text-ink-500">
                No document uploaded — the record asserts the cover, nothing evidences it.
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              className="text-xs text-ink-600 file:mr-2 file:rounded file:border-0 file:bg-ink-100 file:px-2 file:py-1 file:text-xs file:font-medium file:text-ink-700"
            />
            <Button size="sm" disabled={busy} onClick={() => void onUpload()}>
              {cert.fileId ? "Replace file" : "Upload file"}
            </Button>
          </div>

          {/* --------------------------------- edit --------------------------------- */}
          <SectionTitle>Amend</SectionTitle>
          {!editOpen ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={openEdit}>
                Edit certificate
              </Button>
              {confirmDelete ? null : (
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3 rounded-lg bg-ink-50 p-3">
              <ErrorAlert message={editError} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Subject">
                  <Input
                    value={edit.subjectName}
                    onChange={(e) => setEdit({ ...edit, subjectName: e.target.value })}
                  />
                </Field>
                <Field label="Policy type ✱">
                  <Select
                    value={edit.policyType}
                    onChange={(e) => setEdit({ ...edit, policyType: e.target.value })}
                  >
                    {POLICY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {policyTypeLabel(t)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Insurer ✱">
                  <Input
                    value={edit.insurer}
                    onChange={(e) => setEdit({ ...edit, insurer: e.target.value })}
                  />
                </Field>
                <Field label="Certificate number">
                  <Input
                    value={edit.certificateNumber}
                    onChange={(e) => setEdit({ ...edit, certificateNumber: e.target.value })}
                  />
                </Field>
                <Field label="Limit of indemnity ✱">
                  <Input
                    type="number"
                    min={0}
                    step="any"
                    value={edit.limitOfIndemnity}
                    onChange={(e) => setEdit({ ...edit, limitOfIndemnity: e.target.value })}
                  />
                </Field>
                <Field label="Currency">
                  <Input
                    maxLength={3}
                    value={edit.currency}
                    onChange={(e) => setEdit({ ...edit, currency: e.target.value })}
                  />
                </Field>
                <Field label="Valid from ✱">
                  <Input
                    type="date"
                    value={edit.validFrom}
                    onChange={(e) => setEdit({ ...edit, validFrom: e.target.value })}
                  />
                </Field>
                <Field label="Valid to ✱">
                  <Input
                    type="date"
                    value={edit.validTo}
                    onChange={(e) => setEdit({ ...edit, validTo: e.target.value })}
                  />
                </Field>
                <Field label="Vendor">
                  <Select
                    value={edit.vendorId}
                    onChange={(e) => setEdit({ ...edit, vendorId: e.target.value })}
                  >
                    <option value="">Not linked</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Status">
                  <Select
                    value={edit.status}
                    onChange={(e) => setEdit({ ...edit, status: e.target.value })}
                  >
                    {CERTIFICATE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <p className="text-xs text-ink-500">
                ✱ Substance. Editing validity dates, the limit, the insurer or the policy type
                changes what the evidence says, so the API clears the verification and it has to be
                done again by somebody independent.
              </p>

              {willClearVerification ? (
                <div className="rounded-md border-l-4 border-red-600 bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-900">
                  <strong>This save will clear the verification.</strong> You have changed{" "}
                  {Object.keys(payload)
                    .filter((k) => (SUBSTANTIVE as readonly string[]).includes(k))
                    .join(", ")}
                  , and this certificate is currently verified (
                  {VERIFICATION_METHOD_LABELS[cert.verificationMethod ?? ""] ??
                    cert.verificationMethod}
                  , {formatDateTime(cert.verifiedAt)}). After saving,{" "}
                  <code className="text-[11px]">verifiedAt</code>,{" "}
                  <code className="text-[11px]">verifiedBy</code> and{" "}
                  <code className="text-[11px]">verificationMethod</code> are set to null and the
                  certificate reads unverified until somebody verifies it again.
                  <label className="mt-2 flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I understand the verification will be discarded
                  </label>
                </div>
              ) : null}

              <div className="flex gap-2">
                <Button
                  disabled={busy || (willClearVerification && !ack)}
                  onClick={() => void onSaveEdit()}
                >
                  {busy ? "Saving…" : "Save changes"}
                </Button>
                <Button variant="secondary" onClick={() => setEditOpen(false)}>
                  Cancel
                </Button>
                {Object.keys(payload).length === 0 ? (
                  <span className="self-center text-xs text-ink-400">Nothing changed yet.</span>
                ) : null}
              </div>
            </div>
          )}

          <ErrorAlert message={deleteError} />
          {confirmDelete ? (
            <div className="mt-3">
              <ConfirmStrip
                message={
                  <>
                    Delete this certificate for {cert.subjectName}? The evidence and its link to the
                    uploaded file are removed from the register. Cover-gap analysis will stop seeing
                    it, which may open a gap.
                  </>
                }
                confirmLabel="Delete certificate"
                busy={busy}
                onCancel={() => setConfirmDelete(false)}
                onConfirm={() => void onDelete()}
              />
            </div>
          ) : null}
        </div>
      )}
    </Drawer>
  );
}
