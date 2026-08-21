/**
 * Ledger tab — verify the company's append-only hash chain and inspect the
 * mutation history of any object by type + id.
 */
import { useState, type FormEvent } from "react";
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
  Spinner,
} from "../../ui";
import { formatDateTime, humanize } from "../format";
import { HashChip, type LedgerEntryRow, type ListResponse } from "./assuranceShared";

interface VerifyResult {
  count: number;
  valid: boolean;
  brokenAt?: number | null;
  reason?: string | null;
}

function actionTone(action: string): string {
  switch (action) {
    case "create":
      return "green";
    case "update":
      return "blue";
    case "state_change":
      return "amber";
    case "delete":
      return "red";
    default:
      return "gray";
  }
}

export default function LedgerTab() {
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [objectType, setObjectType] = useState("");
  const [objectId, setObjectId] = useState("");
  const [entries, setEntries] = useState<LedgerEntryRow[] | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  async function runVerify() {
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await api.get<VerifyResult>("/api/v1/ledger/verify");
      setVerify(res);
    } catch (err) {
      setVerify(null);
      setVerifyError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifyBusy(false);
    }
  }

  async function runLookup(e: FormEvent) {
    e.preventDefault();
    setLookupBusy(true);
    setLookupError(null);
    try {
      const params = new URLSearchParams({ pageSize: "100" });
      if (objectType.trim()) params.set("objectType", objectType.trim());
      if (objectId.trim()) params.set("objectId", objectId.trim());
      const res = await api.get<ListResponse<LedgerEntryRow>>(`/api/v1/ledger?${params}`);
      setEntries(res.items);
    } catch (err) {
      setEntries([]);
      setLookupError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLookupBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-ink-900">Chain integrity</div>
              <p className="mt-0.5 text-xs text-ink-500">
                Recomputes every entry hash in sequence — any tampered or missing row breaks the chain.
              </p>
            </div>
            <Button onClick={() => void runVerify()} disabled={verifyBusy}>
              {verifyBusy ? "Verifying…" : "Verify chain"}
            </Button>
          </div>
          <ErrorAlert message={verifyError} />
          {verify ? (
            verify.valid ? (
              <div className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
                Chain intact — {verify.count} entr{verify.count === 1 ? "y" : "ies"} verified.
              </div>
            ) : (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
                <span className="font-semibold">Chain BROKEN</span> at sequence{" "}
                <span className="font-mono">{verify.brokenAt ?? "?"}</span>
                {verify.reason ? ` — ${verify.reason}` : ""}. Treat downstream entries as unverified.
              </div>
            )
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="mb-3 text-sm font-semibold text-ink-900">Object history</div>
          <form onSubmit={runLookup} className="flex flex-wrap items-end gap-3">
            <div className="w-52">
              <Field label="Object type">
                <Input
                  value={objectType}
                  onChange={(e) => setObjectType(e.target.value)}
                  placeholder="assertion, signal, obligation…"
                />
              </Field>
            </div>
            <div className="w-72">
              <Field label="Object id">
                <Input
                  value={objectId}
                  onChange={(e) => setObjectId(e.target.value)}
                  placeholder="asr_… / sig_… / obl_…"
                  className="font-mono"
                />
              </Field>
            </div>
            <Button type="submit" disabled={lookupBusy}>
              {lookupBusy ? "Searching…" : "Look up"}
            </Button>
          </form>
          <div className="mt-3">
            <ErrorAlert message={lookupError} />
            {lookupBusy ? (
              <Spinner />
            ) : entries === null ? (
              <p className="text-xs text-ink-400">
                Enter an object type and/or id to trace its full mutation history.
              </p>
            ) : entries.length === 0 ? (
              <EmptyState title="No ledger entries match" hint="Check the object type and id." />
            ) : (
              <ol className="relative ml-3 space-y-4 border-l border-ink-200 pl-5">
                {entries.map((en) => (
                  <li key={en.seq} className="relative">
                    <span className="absolute -left-[1.65rem] top-1 h-2.5 w-2.5 rounded-full bg-brand-500 ring-4 ring-white" />
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-ink-400">#{en.seq}</span>
                      <Badge tone={actionTone(en.action)}>{humanize(en.action)}</Badge>
                      <span className="text-sm font-medium text-ink-900">
                        {en.objectType}
                      </span>
                      <span className="font-mono text-xs text-ink-500">{en.objectId}</span>
                      <span className="text-xs text-ink-400">{formatDateTime(en.at)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500">
                      <span>
                        entry <HashChip value={en.entryHash} />
                      </span>
                      <span>
                        prev <HashChip value={en.prevHash} />
                      </span>
                      <span>
                        payload <HashChip value={en.payloadHash} />
                      </span>
                      {en.actorId ? (
                        <span>
                          actor <span className="font-mono">{en.actorId}</span>
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
