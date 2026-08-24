/**
 * Submissions tab: the pleadings register (#339) — referral, response, reply,
 * rejoinder, witness statements, expert reports, decisions and awards — with
 * party attribution and the served file on record.
 */
import { useEffect, useState, type FormEvent } from "react";
import { SUBMISSION_KINDS } from "@constructos/shared";
import { api, ApiClientError, fetchBlobUrl } from "../../lib/api";
import {
  Badge,
  Button,
  ErrorAlert,
  Field,
  Input,
  Modal,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "../../ui";
import { formatDate, humanize } from "../format";
import {
  isTerminal,
  partyTone,
  SectionTitle,
  todayIso,
  type DisputeDetail,
  type FileLite,
  type ListResponse,
} from "./disputesShared";

const PARTIES = ["claimant", "respondent", "tribunal"] as const;

export default function SubmissionsTab({
  projectId,
  dispute,
  onChanged,
}: {
  projectId: string;
  dispute: DisputeDetail;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/v1/projects/${projectId}`;
  const [error, setError] = useState<string | null>(null);
  const active = !isTerminal(dispute.status);

  /* ------------------------------- file download ------------------------------ */

  async function downloadFile(fileId: string) {
    setError(null);
    try {
      const url = await fetchBlobUrl(`/api/v1/files/${fileId}/download`);
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "File download failed");
    }
  }

  /* --------------------------------- add modal -------------------------------- */

  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sKind, setSKind] = useState("referral");
  const [sTitle, setSTitle] = useState("");
  const [sParty, setSParty] = useState("claimant");
  const [sServedAt, setSServedAt] = useState(todayIso());
  const [sFileId, setSFileId] = useState("");
  const [sNote, setSNote] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [files, setFiles] = useState<FileLite[]>([]);

  function openAdd() {
    setAddError(null);
    setSKind("referral");
    setSTitle("");
    setSParty("claimant");
    setSServedAt(todayIso());
    setSFileId("");
    setSNote("");
    setFileSearch("");
    setAddOpen(true);
  }

  useEffect(() => {
    if (!addOpen) return;
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({ pageSize: "50" });
          if (fileSearch.trim()) params.set("search", fileSearch.trim());
          const res = await api.get<ListResponse<FileLite>>(`${base}/files?${params}`);
          if (!cancelled) setFiles(res.items);
        } catch {
          // picker is optional
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [addOpen, fileSearch, base]);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        kind: sKind,
        title: sTitle.trim(),
        party: sParty,
        servedAt: sServedAt,
      };
      if (sFileId) payload["fileId"] = sFileId;
      if (sNote.trim()) payload["note"] = sNote.trim();
      await api.post(`${base}/disputes/${dispute.id}/submissions`, payload);
      setAddOpen(false);
      await onChanged();
    } catch (err) {
      setAddError(err instanceof ApiClientError ? err.message : "Failed to record the submission.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorAlert message={error} />

      <div className="mb-3 flex items-center justify-between">
        <SectionTitle>Pleadings register ({dispute.submissions.length})</SectionTitle>
        {active ? (
          <Button size="sm" onClick={openAdd}>
            Record submission…
          </Button>
        ) : null}
      </div>

      {dispute.submissions.length === 0 ? (
        <p className="text-xs text-ink-400">
          Nothing served yet — record the referral, responses, witness statements and expert
          reports as they are served so the register mirrors the tribunal&rsquo;s file.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Kind</Th>
              <Th>Title</Th>
              <Th>Party</Th>
              <Th>Served</Th>
              <Th>File</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {dispute.submissions.map((s) => (
              <tr key={s.id}>
                <Td>
                  <Badge tone={s.kind === "decision" || s.kind === "award" ? "violet" : "blue"}>
                    {humanize(s.kind)}
                  </Badge>
                </Td>
                <Td className="max-w-56">
                  <span className="block truncate font-medium text-ink-900" title={s.title}>
                    {s.title}
                  </span>
                  {s.note ? (
                    <span className="block truncate text-xs text-ink-400" title={s.note}>
                      {s.note}
                    </span>
                  ) : null}
                </Td>
                <Td>
                  <Badge tone={partyTone(s.party)}>{humanize(s.party)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-xs">{formatDate(s.servedAt)}</Td>
                <Td>
                  {s.fileId ? (
                    <button
                      type="button"
                      onClick={() => void downloadFile(s.fileId!)}
                      className="text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
                    >
                      Download
                    </button>
                  ) : (
                    <span className="text-xs text-ink-300">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* --------------------------------- add modal -------------------------------- */}
      <Modal open={addOpen} title="Record a submission" onClose={() => setAddOpen(false)} wide>
        <ErrorAlert message={addError} />
        <form onSubmit={onAdd} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind">
              <Select value={sKind} onChange={(e) => setSKind(e.target.value)}>
                {SUBMISSION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanize(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Party">
              <Select value={sParty} onChange={(e) => setSParty(e.target.value)}>
                {PARTIES.map((p) => (
                  <option key={p} value={p}>
                    {humanize(p)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Served on">
              <Input
                type="date"
                required
                value={sServedAt}
                onChange={(e) => setSServedAt(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Title">
            <Input
              required
              value={sTitle}
              onChange={(e) => setSTitle(e.target.value)}
              placeholder="Referral notice and supporting appendices"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Search files" hint="Filter the served-document picker.">
              <Input
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                placeholder="referral.pdf…"
              />
            </Field>
            <Field label="Served document">
              <Select value={sFileId} onChange={(e) => setSFileId(e.target.value)}>
                <option value="">None</option>
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Note">
            <Textarea
              value={sNote}
              onChange={(e) => setSNote(e.target.value)}
              className="min-h-10"
              placeholder="Served by email at 16:42, one day inside the timetable…"
            />
          </Field>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Recording…" : "Record submission"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
