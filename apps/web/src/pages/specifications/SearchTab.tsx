/**
 * TEXT SEARCH — find the clause, not the section title (#298).
 *
 * The Sections tab filters the binder by code and title. This searches the
 * WORDS: Postgres full-text over the extracted text of each section's
 * CURRENT revision, ranked, with the matching passage shown.
 *
 * Two honesty rules are visible on screen. Superseded text is not searched,
 * so "no result" never means "the project never specified this" — it means
 * the text in force does not say it; the basis line says so. And a section
 * whose revision has no extracted text (a scanned issue with no text layer)
 * cannot match at all, which is reported rather than silently returning
 * nothing.
 */
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Field,
  Input,
  Spinner,
} from "../../ui";
import { IconSearch } from "../../ui/icons";
import {
  LoadError,
  count,
  snippetRuns,
  titleCase,
  type Loadable,
  type SpecSearchResponse,
} from "./specShared";

export default function SearchTab({
  query,
  onQuery,
  results,
  onOpenSection,
}: {
  query: string;
  onQuery: (next: string) => void;
  results: Loadable<SpecSearchResponse>;
  onOpenSection: (sectionId: string) => void;
}) {
  const [draft, setDraft] = useState(query);
  const data = results.data;
  const term = query.trim();

  return (
    <div className="space-y-4">
      <Card>
        <CardBody>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              onQuery(draft);
            }}
          >
            <Field
              label="Search the text in force"
              hint="Two characters or more. Words are stemmed, so “waterproofing” finds “waterproof”."
              className="min-w-64 flex-1"
            >
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. curing compound, mock-up panel, 28-day strength"
                leading={IconSearch}
                maxLength={200}
              />
            </Field>
            <Button type="submit" size="sm" disabled={draft.trim().length < 2}>
              Search
            </Button>
            {term ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraft("");
                  onQuery("");
                }}
              >
                Clear
              </Button>
            ) : null}
          </form>
        </CardBody>
      </Card>

      {results.error ? (
        <LoadError
          message={results.error}
          onRetry={results.reload}
          title="The search could not be run"
        />
      ) : null}

      {term.length < 2 ? (
        <EmptyState
          icon={IconSearch}
          title="Search the specification text"
          hint="This reads the clauses themselves, not the section titles. Only the CURRENT revision of each section is searched — superseded text is deliberately excluded, because the question “what does the spec say” is a question about the text in force."
        />
      ) : results.loading ? (
        <div className="flex items-center gap-2 p-6 text-meta text-content-muted">
          <Spinner size="sm" /> Searching the text in force…
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon={IconSearch}
          title={`Nothing in the text in force matches “${data.q}”`}
          hint="A section whose current revision has no extracted text — a scanned issue with no text layer — cannot match. Check the Sections tab for revisions with no text before concluding the spec is silent."
        />
      ) : data ? (
        <div className="space-y-3">
          <p className="text-meta text-content-muted">
            {count(data.total)} section{data.total === 1 ? "" : "s"} match “{data.q}”.
          </p>
          {data.items.map((hit) => (
            <Card key={hit.sectionId}>
              <CardBody className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="font-mono text-sm font-semibold text-accent-fg hover:underline"
                    onClick={() => onOpenSection(hit.sectionId)}
                  >
                    {hit.code}
                  </button>
                  <span className="text-sm text-content">{hit.title}</span>
                  <Badge tone="neutral" size="xs" variant="outline">
                    rev {hit.revision}
                  </Badge>
                  <Badge
                    tone={hit.status === "current" ? "success" : "neutral"}
                    size="xs"
                    variant="outline"
                  >
                    {titleCase(hit.status)}
                  </Badge>
                  {hit.pageStart !== null ? (
                    <span className="text-2xs text-content-subtle">
                      from page {hit.pageStart} of the book
                    </span>
                  ) : null}
                </div>
                <p className="whitespace-normal text-meta leading-relaxed text-content-muted">
                  {snippetRuns(hit.snippet).map((run, i) =>
                    run.hit ? (
                      <mark key={i} className="rounded-sm bg-warning-subtle px-0.5 text-content">
                        {run.text}
                      </mark>
                    ) : (
                      <span key={i}>{run.text}</span>
                    ),
                  )}
                </p>
              </CardBody>
            </Card>
          ))}
          <Alert tone="info" variant="subtle" size="sm" title="Basis">
            {data.basis}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
