/**
 * SPEC BOOKS — upload an issue, watch it split, then accept it.
 *
 * Three facts this tab refuses to blur:
 *
 *  · A SPLIT IS NOT A REGISTER. The upload result reports divisions, sections,
 *    revisions and requirements *extracted* — and prints `requirementsConfirmed`
 *    as the zero it always is, because a machine reading confirms nothing.
 *  · AN UNCHANGED REISSUE IS PROVABLE. `unchangedSections` is the count the
 *    content hash caught: text that came back byte-identical and therefore
 *    created no phantom revision to diff against.
 *  · ACCEPTANCE IS A SECOND PERSON'S ACT. The uploader says "this is the book
 *    we were sent"; the accepter says "this is the book we are building to".
 *    The API refuses to let one person do both, and the button says so before
 *    it is pressed rather than after it fails.
 */
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  FileDropzone,
  Input,
  Modal,
  Select,
  Skeleton,
  Tooltip,
  useConfirm,
  type DataColumns,
} from "../../ui";
import { IconSpec, IconUpload } from "../../ui/icons";
import { api } from "../../lib/api";
import {
  BOOK_STATUS_TONE,
  EM_DASH,
  LoadError,
  PROCESSING_TONE,
  ReasonList,
  RefusalPanel,
  count,
  dateTime,
  isoDate,
  shortHash,
  titleCase,
  useAction,
  type BuildRegisterResult,
  type Loadable,
  type Paginated,
  type SpecBook,
  type SpecBookUploadResult,
} from "./specShared";

const CLASSIFICATIONS = [
  { value: "masterformat_2020", label: "MasterFormat 2020" },
  { value: "masterformat_1995", label: "MasterFormat 1995" },
  { value: "uniclass_2015", label: "Uniclass 2015" },
  { value: "nbs_chapters", label: "NBS chapters" },
  { value: "custom", label: "Custom" },
] as const;

interface UploadForm {
  name: string;
  issueLabel: string;
  issuedDate: string;
  issuedByOrganisation: string;
  description: string;
  classificationSystem: string;
  makeCurrent: boolean;
  extractRequirements: boolean;
}

const EMPTY_FORM: UploadForm = {
  name: "",
  issueLabel: "",
  issuedDate: "",
  issuedByOrganisation: "",
  description: "",
  classificationSystem: "masterformat_2020",
  makeCurrent: false,
  extractRequirements: true,
};

export default function BooksTab({
  projectId,
  books,
  onChanged,
  onOpenSections,
}: {
  projectId: string;
  books: Loadable<Paginated<SpecBook>>;
  onChanged: () => void;
  onOpenSections: (bookId: string) => void;
}) {
  const { busy, refusal, clear, run } = useAction();
  const { confirm, dialog } = useConfirm();

  const [uploadOpen, setUploadOpen] = useState(false);
  const [form, setForm] = useState<UploadForm>(EMPTY_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<SpecBookUploadResult | null>(null);
  const [built, setBuilt] = useState<BuildRegisterResult | null>(null);

  const rows = books.data?.items ?? [];

  async function submitUpload() {
    if (!file) return;
    const body = new FormData();
    body.append("file", file, file.name);
    if (form.name.trim()) body.append("name", form.name.trim());
    if (form.issueLabel.trim()) body.append("issueLabel", form.issueLabel.trim());
    if (form.issuedDate) body.append("issuedDate", form.issuedDate);
    if (form.issuedByOrganisation.trim()) {
      body.append("issuedByOrganisation", form.issuedByOrganisation.trim());
    }
    if (form.description.trim()) body.append("description", form.description.trim());
    body.append("classificationSystem", form.classificationSystem);
    body.append("makeCurrent", form.makeCurrent ? "1" : "0");
    body.append("extractRequirements", form.extractRequirements ? "1" : "0");

    setUploading(true);
    const created = await run("upload", () =>
      api.upload<SpecBookUploadResult>(`/api/v1/projects/${projectId}/spec-books`, body),
    );
    setUploading(false);
    if (created) {
      setResult(created);
      setUploadOpen(false);
      setForm(EMPTY_FORM);
      setFile(null);
      onChanged();
    }
  }

  async function accept(book: SpecBook) {
    const ok = await confirm({
      title: `Accept ${book.reference}?`,
      description:
        "Accepting an issue is a statement that this is the book the project is building to — separate from the upload, which only said it is the book we were sent. The platform refuses to let the uploader accept their own book, so if you uploaded this one, ask a colleague.",
      confirmLabel: "Accept this issue",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run(`accept:${book.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/spec-books/${book.id}/accept`, {}),
    );
    if (done !== null) onChanged();
  }

  async function setCurrent(book: SpecBook) {
    const ok = await confirm({
      title: `Make ${book.reference} the current issue?`,
      description:
        "Exactly one book drives the register. The book this replaces is marked superseded in both directions and stays fully readable — a submittal approved two years ago was approved against that text, and that has to remain provable.",
      confirmLabel: "Make current",
      tone: "warning",
    });
    if (!ok) return;
    const done = await run(`current:${book.id}`, () =>
      api.post(`/api/v1/projects/${projectId}/spec-books/${book.id}/set-current`, {}),
    );
    if (done !== null) onChanged();
  }

  async function buildRegister(book: SpecBook) {
    const ok = await confirm({
      title: `Build the submittal register from ${book.reference}?`,
      description:
        "Every CONFIRMED requirement in this book becomes a real submittal. Everything else is skipped and reported item by item — this never confirms anything on your behalf, because the whole value of a register built from the spec is that a person agreed each row belongs in it.",
      confirmLabel: "Build the register",
    });
    if (!ok) return;
    const outcome = await run(`build:${book.id}`, () =>
      api.post<BuildRegisterResult>(
        `/api/v1/projects/${projectId}/spec-books/${book.id}/build-register`,
        {},
      ),
    );
    if (outcome) {
      setBuilt(outcome);
      onChanged();
    }
  }

  const columns = useMemo<DataColumns<SpecBook>>(
    () => [
      {
        id: "reference",
        header: "Issue",
        accessor: "reference",
        type: "code",
        sticky: "start",
        width: 120,
        mono: true,
      },
      {
        id: "name",
        header: "Name",
        accessor: "name",
        type: "text",
        width: 260,
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{row.name}</span>
            {row.isCurrent === 1 ? (
              <Badge tone="success" size="xs" variant="solid">
                Current
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "issueLabel",
        header: "Issue label",
        accessor: (row) => row.issueLabel ?? "",
        type: "text",
        width: 130,
        cell: ({ row }) =>
          row.issueLabel ?? <span className="italic text-content-subtle">unlabelled</span>,
      },
      {
        id: "issuedDate",
        header: "Issued",
        accessor: (row) => row.issuedDate ?? "",
        type: "text",
        width: 110,
        cell: ({ row }) => isoDate(row.issuedDate),
      },
      {
        id: "processing",
        header: "Split",
        accessor: "processing",
        type: "status",
        width: 190,
        groupable: true,
        cell: ({ row }) => (
          <span className="min-w-0 py-0.5">
            <Badge tone={PROCESSING_TONE[row.processing] ?? "neutral"} size="xs" dot>
              {titleCase(row.processing)}
            </Badge>
            {row.processingError ? (
              <p className="mt-0.5 whitespace-normal text-2xs leading-snug text-danger-fg">
                {row.processingError}
              </p>
            ) : null}
          </span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessor: "status",
        type: "status",
        width: 130,
        groupable: true,
        cell: ({ row }) => (
          <Badge tone={BOOK_STATUS_TONE[row.status] ?? "neutral"} size="xs">
            {titleCase(row.status)}
          </Badge>
        ),
      },
      {
        id: "structure",
        header: "Structure",
        accessor: (row) => row.sectionCount,
        type: "number",
        align: "right",
        width: 150,
        aggregate: "none",
        cell: ({ row }) => (
          <span className="tabular-nums">
            {count(row.divisionCount)} div · {count(row.sectionCount)} sec
            {row.pageCount !== null ? ` · ${count(row.pageCount)} pp` : ""}
          </span>
        ),
      },
      {
        id: "accepted",
        header: "Accepted",
        accessor: (row) => row.acceptedAt ?? "",
        type: "text",
        width: 190,
        cell: ({ row }) =>
          row.acceptedAt ? (
            <span className="text-meta">{dateTime(row.acceptedAt)}</span>
          ) : (
            <Tooltip content="The uploader may not accept their own issue. Until a second person accepts it, this book is what we were sent — not what we are building to.">
              <span>
                <Badge tone="warning" size="xs">
                  Awaiting a second person
                </Badge>
              </span>
            </Tooltip>
          ),
      },
      {
        id: "register",
        header: "Register built",
        accessor: (row) => row.registerBuiltAt ?? "",
        type: "text",
        width: 180,
        cell: ({ row }) =>
          row.registerBuiltAt ? (
            <span className="text-meta">{dateTime(row.registerBuiltAt)}</span>
          ) : (
            <span className="italic text-content-subtle">never</span>
          ),
      },
      {
        id: "sha",
        header: "Source SHA-256",
        accessor: (row) => row.sourceFileSha256 ?? "",
        type: "code",
        width: 150,
        mono: true,
        defaultHidden: true,
        cell: ({ row }) => (
          <Tooltip content={row.sourceFileSha256 ?? "No source file is held for this book."}>
            <span className="font-mono text-2xs">{shortHash(row.sourceFileSha256)}</span>
          </Tooltip>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {dialog}
      <RefusalPanel refusal={refusal} onDismiss={clear} />
      {books.error ? (
        <LoadError
          message={books.error}
          onRetry={books.reload}
          title="The spec books could not be loaded"
        />
      ) : null}

      {result ? <SplitReport result={result} onDismiss={() => setResult(null)} /> : null}
      {built ? <BuildReport result={built} onDismiss={() => setBuilt(null)} /> : null}

      {books.loading && rows.length === 0 ? (
        <Card>
          <CardBody className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
          </CardBody>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={IconSpec}
          title="No specification has been uploaded to this project"
          hint="The submittal register on this platform is built from the spec book, not typed by hand. Until a book is uploaded and split into sections there is nothing for the register to be built from — which is why this list is empty rather than showing a zero."
          action={
            <Button icon={IconUpload} onClick={() => setUploadOpen(true)}>
              Upload a spec book
            </Button>
          }
        />
      ) : (
        <DataTable<SpecBook>
          tableId="spec-books"
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          loading={books.loading}
          height={480}
          stickyHeader
          gridLines
          filterRow
          savedViews
          exportFileName="spec-books"
          searchPlaceholder="Search issues…"
          defaultSort={[{ id: "reference", desc: true }]}
          rowTone={(row) =>
            row.processing === "failed" ? "danger" : row.isCurrent === 1 ? "success" : undefined
          }
          onRowClick={({ row }) => onOpenSections(row.id)}
          rowActions={(row) => [
            {
              id: "sections",
              label: "Browse this issue's sections",
              onSelect: () => onOpenSections(row.id),
            },
            {
              id: "accept",
              label: row.acceptedAt ? "Already accepted" : "Accept this issue",
              disabled: Boolean(row.acceptedAt) || row.processing !== "ready",
              onSelect: () => void accept(row),
            },
            {
              id: "current",
              label: "Make this the current issue",
              disabled: row.isCurrent === 1 || row.processing !== "ready",
              onSelect: () => void setCurrent(row),
            },
            {
              id: "build",
              label: "Build the register from this issue",
              disabled: row.processing !== "ready",
              onSelect: () => void buildRegister(row),
            },
          ]}
          toolbarActions={
            <Button
              size="sm"
              icon={IconUpload}
              onClick={() => setUploadOpen(true)}
              disabled={busy !== null}
            >
              Upload an issue
            </Button>
          }
          empty={{
            title: "No spec book on this project",
            description: "Upload the PDF issue and it will be split into divisions and sections.",
          }}
          emptyFiltered={{
            title: "No issue matches these filters",
            description: "Clear the status or split-state filter to see the rest of the issues.",
          }}
          aria-label="Spec books"
        />
      )}

      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title="Upload a specification issue"
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitUpload()}
              disabled={!file || uploading}
              loading={uploading}
            >
              Upload and split
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <Alert tone="info" variant="subtle" size="sm" title="What happens when you press upload">
            The PDF is stored once and content-addressed. Its text is read page by page, section
            headings are detected, and each section owns every page from its heading to the page
            before the next one. A section whose text hashes identically to the revision in force
            creates no new revision at all — an unchanged reissue has to be provable as unchanged.
            Nothing extracted here is confirmed by anybody.
          </Alert>

          <FileDropzone
            accept="application/pdf,.pdf"
            multiple={false}
            maxFiles={1}
            autoUpload={false}
            label="The specification PDF"
            hint="A text-bearing PDF. A scanned book with no text layer cannot be split — the API will say so rather than inventing sections."
            onAccepted={(files) => setFile(files[0] ?? null)}
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" hint="Defaults to the file name.">
              <Input
                value={form.name}
                placeholder="Project Specification"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Issue label" hint="IFC, Tender, Addendum 3 — how the designer named it.">
              <Input
                value={form.issueLabel}
                placeholder="IFC"
                onChange={(e) => setForm({ ...form, issueLabel: e.target.value })}
              />
            </Field>
            <Field label="Issued date">
              <Input
                type="date"
                value={form.issuedDate}
                onChange={(e) => setForm({ ...form, issuedDate: e.target.value })}
              />
            </Field>
            <Field label="Issued by" hint="The party that issued the text — the designer, not us.">
              <Input
                value={form.issuedByOrganisation}
                placeholder="Consultant or design practice"
                onChange={(e) => setForm({ ...form, issuedByOrganisation: e.target.value })}
              />
            </Field>
            <Field label="Classification system" className="sm:col-span-2">
              <Select
                value={form.classificationSystem}
                onChange={(e) => setForm({ ...form, classificationSystem: e.target.value })}
              >
                {CLASSIFICATIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="space-y-2 rounded-lg border border-border bg-surface-raised p-3">
            <Checkbox
              checked={form.extractRequirements}
              onChange={(e) => setForm({ ...form, extractRequirements: e.target.checked })}
              label="Extract submittal requirements while splitting"
              description="Reads Part 1.3 of each section and proposes the submittals it demands. Every row lands as identified — a machine reading, unconfirmed, not registrable."
            />
            <Checkbox
              checked={form.makeCurrent}
              onChange={(e) => setForm({ ...form, makeCurrent: e.target.checked })}
              label="Make this the current issue once it has split"
              description="Supersedes whichever book is current today, in both directions. The superseded book stays readable."
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** What the split actually did — including what it deliberately did not do. */
function SplitReport({
  result,
  onDismiss,
}: {
  result: SpecBookUploadResult;
  onDismiss: () => void;
}) {
  if (result.error) {
    return (
      <Alert
        tone="danger"
        title={`${result.reference} could not be split`}
        onDismiss={onDismiss}
      >
        <p className="whitespace-pre-wrap">{result.error}</p>
        <p className="mt-2 text-meta">
          The book row and the uploaded file are kept. Nothing was invented in place of the sections
          that could not be found.
        </p>
      </Alert>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-content">
            {result.reference} split into {count(result.sectionsInBook)} section
            {result.sectionsInBook === 1 ? "" : "s"}
          </p>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Divisions" value={result.divisionsCreated} />
          <Figure label="Sections in book" value={result.sectionsInBook} />
          <Figure label="New sections" value={result.sectionsCreated} />
          <Figure label="Revisions added" value={result.revisionsAdded} />
          <Figure
            label="Unchanged"
            value={result.unchangedSections}
            hint="Text identical to the revision in force — no phantom revision was created."
          />
          <Figure
            label="Requirements read"
            value={result.requirementsExtracted}
            tone="warning"
            hint="Machine readings. None is confirmed."
          />
        </dl>
        <Alert tone="warning" variant="subtle" size="sm" title="Confirmed by a human: 0">
          Extraction is not validation. All {count(result.requirementsExtracted)} extracted
          requirement{result.requirementsExtracted === 1 ? "" : "s"} sit at{" "}
          <strong>identified</strong> and none of them can be registered as a submittal until
          somebody other than the extractor reads the clause and confirms it. Work through them in
          the review queue.
        </Alert>
      </CardBody>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div>
      <dt className="text-label uppercase text-content-subtle">{label}</dt>
      <dd
        className={
          tone === "warning"
            ? "text-lg font-semibold tabular-nums text-warning-fg"
            : "text-lg font-semibold tabular-nums text-content"
        }
      >
        {count(value)}
      </dd>
      {hint ? <p className="mt-0.5 text-2xs text-content-subtle">{hint}</p> : null}
    </div>
  );
}

/** The build report: what it registered, and item by item what it refused to. */
function BuildReport({
  result,
  onDismiss,
}: {
  result: BuildRegisterResult;
  onDismiss: () => void;
}) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-content">
            Register built from {result.bookReference ?? result.bookId}:{" "}
            {count(result.registeredCount)} registered, {count(result.skippedCount)} skipped
          </p>
          <Button size="xs" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <ReasonList reasons={result.reasons} />
        {result.skipped.length > 0 ? (
          <div>
            <p className="text-meta font-semibold text-content">
              Skipped — and why, one row at a time
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {result.skipped.map((s) => (
                <li key={s.requirementId} className="flex items-start gap-2">
                  <Badge tone={s.status === "identified" ? "warning" : "neutral"} size="xs">
                    {titleCase(s.status)}
                  </Badge>
                  <span className="min-w-0 text-meta text-content-muted">
                    <span className="font-mono text-content">{s.sectionCode}</span> — {s.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {result.registered.length > 0 ? (
          <p className="text-meta text-content-muted">
            {count(result.registered.length)} submittal
            {result.registered.length === 1 ? " was" : "s were"} created, each carrying its section
            code and the requirement it was built from. The requirements are frozen now — the
            submittals are the live records.
          </p>
        ) : (
          <p className="text-meta text-content-muted">
            {result.skippedCount > 0
              ? `Nothing was registered ${EM_DASH} every requirement in this book is either unconfirmed or already registered. Confirmation is a human act and this build never performs it for you.`
              : "Nothing was registered, because this book holds no requirements at all."}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
