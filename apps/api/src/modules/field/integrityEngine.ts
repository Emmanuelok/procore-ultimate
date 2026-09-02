/**
 * Field-record integrity detectors (Vol II owner-side assurance). Each
 * function takes the record(s) it needs and returns a finding or null. The
 * ledger hook in integrity.ts decides when to run them and persists the
 * resulting signal with evidence refs pointing at the ledger sequence that
 * triggered it, so an integrity reviewer can disposition the signal against
 * the exact entries.
 *
 * Detectors are conservative: every one describes a pattern that is
 * sometimes legitimate, so severity is "medium" unless the pattern defeats a
 * control outright (a punch item verified by its own assignee).
 */
import { haversineKm } from "./photoEngine.js";
import { daysBetween, isBusinessDay } from "./dates.js";

export interface Finding {
  detector: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  title: string;
  explanation: string;
}

/** An RFI answered by the person who asked it is a question answering itself. */
export function detectRfiSelfAnswer(rfi: {
  number: number;
  createdBy: string;
  respondedBy: string | null;
  status: string;
}): Finding | null {
  if (rfi.status !== "answered" || !rfi.respondedBy || rfi.respondedBy !== rfi.createdBy) return null;
  return {
    detector: "field_rfi_self_answered",
    severity: "medium",
    confidence: 0.9,
    title: `RFI-${String(rfi.number).padStart(3, "0")} was answered by its own author`,
    explanation:
      "The official response was recorded by the user who raised the RFI. A question and its answer should come from different parties; review whether the response reflects the design team's position or a self-resolution.",
  };
}

/** Question/subject changed after an official response exists. */
export function detectRfiEditedAfterAnswer(
  rfi: { number: number; status: string; officialResponse: string | null },
  changedKeys: readonly string[],
): Finding | null {
  const substantive = changedKeys.filter((k) => k === "question" || k === "subject" || k === "proposedSolution");
  if (substantive.length === 0) return null;
  if (!rfi.officialResponse && rfi.status !== "answered" && rfi.status !== "closed") return null;
  return {
    detector: "field_rfi_question_edited_after_answer",
    severity: "high",
    confidence: 1,
    title: `RFI-${String(rfi.number).padStart(3, "0")} question changed after it was answered`,
    explanation: `Fields ${substantive.join(", ")} were edited after an official response was recorded. The answer may no longer address the question on the record; the before/after values are stored on the ledger entry.`,
  };
}

/** Two hands on every closure: verifier ≠ assignee, verifier ≠ the person who marked it ready. */
export function detectPunchSelfVerification(item: {
  number: number;
  status: string;
  assigneeId: string | null;
  verifierId: string | null;
  readyForReviewBy: string | null;
  closedBy: string | null;
}): Finding | null {
  if (item.status !== "closed" || !item.closedBy) return null;
  const reasons: string[] = [];
  if (item.assigneeId && item.closedBy === item.assigneeId) reasons.push("closed by its assignee");
  if (item.readyForReviewBy && item.closedBy === item.readyForReviewBy) {
    reasons.push("closed by the person who marked it ready for review");
  }
  if (item.verifierId && item.assigneeId && item.verifierId === item.assigneeId) {
    reasons.push("verifier and assignee are the same person");
  }
  if (reasons.length === 0) return null;
  return {
    detector: "field_punch_self_verified",
    severity: "high",
    confidence: 1,
    title: `Punch item #${item.number} was ${reasons[0]}`,
    explanation: `Segregation of duties on the punch sign-off was not observed: ${reasons.join("; ")}. An admin override is legitimate in some cases — confirm why the verifier control was bypassed.`,
  };
}

/** Approval seconds after submission suggests the approver did not read it. */
export function detectRushedDailyLogApproval(
  log: { logDate: string; submittedAt: string | null; approvedAt: string | null; createdBy: string; approvedBy: string | null },
  thresholdSeconds = 60,
): Finding | null {
  if (!log.submittedAt || !log.approvedAt) return null;
  const seconds = (Date.parse(log.approvedAt) - Date.parse(log.submittedAt)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds >= thresholdSeconds) return null;
  return {
    detector: "field_daily_log_rushed_approval",
    severity: "medium",
    confidence: 0.7,
    title: `Daily log ${log.logDate} approved ${Math.round(seconds)}s after submission`,
    explanation: `The log was approved ${Math.round(seconds)} seconds after it was submitted. Approval that fast is unlikely to reflect a review of the manpower, equipment and delay entries the log certifies.`,
  };
}

/** Same approver/creator pair approving every log in a window — co-approval habit. */
export function detectCoApprovalPattern(
  logs: readonly { createdBy: string; approvedBy: string | null }[],
  minimum = 10,
): Finding | null {
  const approved = logs.filter((l) => l.approvedBy);
  if (approved.length < minimum) return null;
  const pairs = new Map<string, number>();
  for (const l of approved) {
    const key = `${l.createdBy}|${l.approvedBy}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  const [topKey, topCount] = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (topCount < approved.length) return null;
  const [creator, approver] = topKey.split("|");
  return {
    detector: "field_daily_log_co_approval_pattern",
    severity: "low",
    confidence: 0.5,
    title: `Every approved daily log (${approved.length}) was approved by the same pair`,
    explanation: `${approved.length} approved logs were all created by ${creator} and approved by ${approver}. A fixed pair can be a small site; it can also be a rubber stamp. Sample a few logs against timecards.`,
  };
}

function businessDaysBetweenTimestamps(a: string, b: string): number {
  let days = 0;
  let cursor = a.slice(0, 10);
  const end = b.slice(0, 10);
  let guard = 0;
  while (cursor < end && guard < 400) {
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
    if (isBusinessDay(cursor)) days += 1;
    guard += 1;
  }
  return days;
}

/** Approved with no comments anywhere in the chain in under a business day. */
export function detectSubmittalRubberStamp(
  sub: { number: number; revision: number; status: string; responseCode: string | null; submittedAt: string | null; respondedAt: string | null },
  steps: readonly { comments: string | null; responseCode: string | null }[],
): Finding | null {
  if (sub.status !== "responded" || sub.responseCode !== "approved") return null;
  if (!sub.submittedAt || !sub.respondedAt) return null;
  const responded = steps.filter((s) => s.responseCode);
  if (responded.length === 0) return null;
  if (responded.some((s) => (s.comments ?? "").trim() !== "")) return null;
  if (businessDaysBetweenTimestamps(sub.submittedAt, sub.respondedAt) >= 1) return null;
  const hours = Math.round(Math.max(0, daysBetween(sub.submittedAt, sub.respondedAt)) * 24 * 10) / 10;
  return {
    detector: "field_submittal_rubber_stamp",
    severity: "medium",
    confidence: 0.6,
    title: `SUB-${String(sub.number).padStart(3, "0")}${sub.revision > 0 ? ` Rev ${sub.revision}` : ""} approved with no comments in ${hours}h`,
    explanation: `${responded.length} reviewer step(s) approved without a single comment, within one business day of submission. Fast, silent approvals are where unreviewed shop drawings get onto site.`,
  };
}

/** A photo taken long before it was uploaded may be recycled evidence. */
export function detectPhotoDateDrift(
  photo: { id: string; takenAt: string | null; createdAt: string },
  maxDays = 7,
): Finding | null {
  if (!photo.takenAt) return null;
  const drift = daysBetween(photo.takenAt, photo.createdAt);
  if (!Number.isFinite(drift) || drift <= maxDays) return null;
  return {
    detector: "field_photo_date_drift",
    severity: "low",
    confidence: 0.6,
    title: `Photo taken ${Math.round(drift)} days before it was uploaded`,
    explanation: `EXIF says the photo was captured on ${photo.takenAt.slice(0, 10)} but it entered the record on ${photo.createdAt.slice(0, 10)}. Backdated site evidence is a known pattern in progress over-claims; check what the photo is attached to.`,
  };
}

/** A photo with GPS outside the project's radius may not be of this site. */
export function detectPhotoOutsideGeofence(
  photo: { id: string; latitude: number | null; longitude: number | null },
  project: { latitude: number | null; longitude: number | null },
  radiusKm = 5,
): Finding | null {
  if (photo.latitude === null || photo.longitude === null) return null;
  if (project.latitude === null || project.longitude === null) return null;
  const km = haversineKm(photo.latitude, photo.longitude, project.latitude, project.longitude);
  if (km <= radiusKm) return null;
  return {
    detector: "field_photo_outside_geofence",
    severity: "medium",
    confidence: 0.7,
    title: `Photo geotagged ${Math.round(km)} km from the project`,
    explanation: `The photo's GPS position is ${Math.round(km * 10) / 10} km from the project's recorded location (radius ${radiusKm} km). It may be a photo of another site; confirm before it supports any progress claim.`,
  };
}
