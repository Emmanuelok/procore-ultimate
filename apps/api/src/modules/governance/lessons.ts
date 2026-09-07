/**
 * Lessons closure gate (spec Vol I §7 / Vol II Domain G #415, Domain W).
 *
 * WHAT IT IS
 * A stage boundary is the last moment an organisation is still able to learn
 * from the stage that is ending: the people are still on the job, the
 * records are still fresh, and nobody has yet been reassigned. Gateway
 * practice therefore makes "lessons captured and signed off" a condition of
 * proceeding, not a closing-report afterthought. A gate with
 * `lessonsRequired` set cannot be decided to proceed while the project's
 * lessons sit unvalidated.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *  - It does not author lessons, judge their quality, or count them against
 *    a quota. "Three lessons per gate" is theatre; one honest lesson that
 *    someone validated is the bar.
 *  - It does not read the learning module's tables through that module's
 *    code. It takes rows and returns a verdict, so the learning module can
 *    evolve without this engine following it.
 *  - It never blocks `stop`, `hold` or `proceed_with_conditions` on its own
 *    initiative — the caller decides which decisions the gate binds.
 */

/** The subset of a lesson this gate needs; anything else is the learning module's business. */
export interface LessonForGate {
  id: string;
  number: string;
  title: string;
  /** LessonStatus: draft | submitted | validated | published | superseded | rejected */
  status: string;
  phase: string | null;
}

export interface LessonsReadiness {
  /** true when the gate is configured to require lessons closure */
  required: boolean;
  /** lessons that exist on this project at all */
  capturedCount: number;
  /** validated, published, superseded or rejected — closed one way or another */
  closedCount: number;
  /** captured but neither validated nor rejected: the blockers */
  outstanding: LessonForGate[];
  ready: boolean;
  /** why it is or is not ready, in the words a reviewer would use */
  reasons: string[];
}

/**
 * A lesson is "closed" once somebody other than the author has ruled on it.
 * `validated` and `published` are acceptances; `rejected` is a decision too
 * (the organisation looked and said no); `superseded` means a later lesson
 * replaced it. Only `draft` and `submitted` are still waiting on a human.
 */
const CLOSED_LESSON_STATUSES = new Set(["validated", "published", "superseded", "rejected"]);

export function assessLessonsReadiness(
  lessons: LessonForGate[],
  options: { required: boolean },
): LessonsReadiness {
  const outstanding = lessons.filter((l) => !CLOSED_LESSON_STATUSES.has(l.status));
  const closedCount = lessons.length - outstanding.length;
  const reasons: string[] = [];

  if (!options.required) {
    reasons.push(
      "This gate does not carry a lessons closure requirement, so lessons are reported for information only.",
    );
    return {
      required: false,
      capturedCount: lessons.length,
      closedCount,
      outstanding,
      ready: true,
      reasons,
    };
  }

  if (lessons.length === 0) {
    reasons.push(
      "No lesson has been captured on this project. A stage that taught the organisation nothing " +
        "is a finding in its own right — record at least one lesson, or record why there is none, " +
        "before the gate is decided.",
    );
    return {
      required: true,
      capturedCount: 0,
      closedCount: 0,
      outstanding: [],
      ready: false,
      reasons,
    };
  }

  if (outstanding.length > 0) {
    reasons.push(
      `${outstanding.length} of ${lessons.length} captured lessons are still awaiting validation ` +
        `(${outstanding.map((l) => l.number).join(", ")}). A lesson nobody has ruled on has not been learned.`,
    );
    return {
      required: true,
      capturedCount: lessons.length,
      closedCount,
      outstanding,
      ready: false,
      reasons,
    };
  }

  reasons.push(
    `All ${lessons.length} captured lessons have been ruled on, so the stage's learning is closed.`,
  );
  return {
    required: true,
    capturedCount: lessons.length,
    closedCount,
    outstanding: [],
    ready: true,
    reasons,
  };
}

/** Decisions the lessons gate binds: only those that let the project move on. */
export const LESSONS_GATED_DECISIONS = ["proceed", "proceed_with_conditions"] as const;

export function lessonsGateApplies(decision: string): boolean {
  return (LESSONS_GATED_DECISIONS as readonly string[]).includes(decision);
}
