/**
 * ONBOARDING PACKS (#994).
 *
 * The first week on a new job is when lessons are most useful and least
 * likely to be read: nobody searches a register for a problem they have not
 * had yet. This tab hands a starting team the lessons from the projects that
 * looked like theirs — same type, same order of value, same phase, and words
 * that match this project's own description — with the reason each one is in
 * the pack printed next to it.
 *
 * The selection is deterministic and always the same. The optional narrative
 * only INTRODUCES lessons it was handed; when no model is configured the pack
 * is unchanged and the page says why the prose is missing rather than failing.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { Badge, Button, Card, CardBody, EmptyState, Field, Select, Spinner } from "../../ui";
import { formatDate } from "../format";
import {
  LoadError,
  NoteCard,
  SectionTitle,
  TagList,
  errorMessage,
  fmtInt,
  impactLabel,
  label,
  type OnboardingPack,
} from "./learningShared";

export default function OnboardingTab({
  projectId,
  onInspect,
}: {
  projectId: string;
  onInspect: (lessonId: string) => void;
}) {
  const [limit, setLimit] = useState("12");
  const [pack, setPack] = useState<OnboardingPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeReason, setNarrativeReason] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNarrative(null);
    setNarrativeReason(null);
    try {
      setPack(
        await api.get<OnboardingPack>(
          `/api/v1/projects/${projectId}/learning/onboarding-pack?limit=${limit}`,
        ),
      );
    } catch (err) {
      setPack(null);
      setError(errorMessage(err, "Failed to assemble the onboarding pack"));
    } finally {
      setLoading(false);
    }
  }, [projectId, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  async function narrate() {
    setNarrating(true);
    try {
      const res = await api.post<OnboardingPack>(
        `/api/v1/projects/${projectId}/learning/onboarding-pack`,
        { limit: Number(limit) },
      );
      setPack(res);
      setNarrative(res.narrative ?? null);
      setNarrativeReason(res.narrativeReason ?? null);
    } catch (err) {
      setNarrativeReason(errorMessage(err, "The narrative was refused"));
    } finally {
      setNarrating(false);
    }
  }

  if (loading && !pack) return <Spinner label="Selecting lessons from similar projects…" />;
  if (error) return <LoadError message={error} onRetry={() => void load()} />;
  if (!pack) return null;

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <SectionTitle hint={pack.selection}>
            Onboarding pack for {pack.project.name}
          </SectionTitle>
          <div className="flex flex-wrap items-end gap-3">
            <div className="text-xs text-ink-500">
              {pack.project.type ? <Badge tone="blue">{label(pack.project.type)}</Badge> : null}{" "}
              <Badge tone="violet">{label(pack.project.stage)}</Badge>{" "}
              <span className="ml-1">
                {pack.project.value === null
                  ? "contract value not recorded, so no value band was matched"
                  : `${pack.project.currency} ${Math.round(pack.project.value).toLocaleString("en-GB")}`}
              </span>
            </div>
            <Field label="Pack size">
              <Select value={limit} onChange={(e) => setLimit(e.target.value)}>
                {["6", "12", "20", "40"].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              Reselect
            </Button>
            <Button onClick={() => void narrate()} disabled={narrating || pack.items.length === 0}>
              {narrating ? "Writing…" : "Add a cited introduction"}
            </Button>
            <span className="text-xs text-ink-400">
              {fmtInt(pack.registerSize)} published lesson
              {pack.registerSize === 1 ? "" : "s"} in the register.
            </span>
          </div>
          {pack.reason ? <NoteCard note={pack.reason} /> : null}
          {narrativeReason ? <NoteCard note={narrativeReason} /> : null}
          {narrative ? (
            <div className="rounded-lg bg-brand-50 p-3 ring-1 ring-brand-100">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-700">
                Introduction — every lesson cited by its number
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                {narrative}
              </p>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {pack.items.length === 0 ? (
        <EmptyState
          title="No lesson matched this project"
          hint="Nothing in the published register shares this project's type, value band, phase or vocabulary. Handing a new team a reading list with no reason attached would be worse than handing them nothing."
        />
      ) : (
        <ul className="space-y-3">
          {pack.items.map((item) => (
            <li key={item.lesson.id} className="rounded-lg bg-ink-50 p-3 ring-1 ring-ink-100">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <span className="font-mono text-xs text-ink-500">{item.lesson.number}</span>{" "}
                  <span className="font-medium text-ink-900">{item.lesson.title}</span>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge tone="blue">{label(item.lesson.category)}</Badge>
                    {item.lesson.phase ? <Badge tone="violet">{item.lesson.phase}</Badge> : null}
                    <span className="text-xs text-ink-500">
                      {impactLabel(
                        item.lesson.impactValue,
                        item.lesson.impactCurrency,
                        item.lesson.impactDays,
                      )}
                    </span>
                    <span className="text-xs text-ink-400">
                      published {formatDate(item.lesson.publishedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded-full bg-brand-600 px-2.5 py-1 text-xs font-bold tabular-nums text-white">
                    {fmtInt(item.score)}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => onInspect(item.lesson.id)}>
                    Inspect
                  </Button>
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Recommendation:{" "}
                </span>
                {item.lesson.recommendation}
              </p>
              <div className="mt-2">
                <TagList tags={item.lesson.tags} />
              </div>
              <div className="mt-2 border-t border-ink-200 pt-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">
                  Why it is in the pack
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink-600">
                  {item.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
