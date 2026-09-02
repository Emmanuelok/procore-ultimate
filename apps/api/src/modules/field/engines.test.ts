import { describe, expect, it } from "vitest";
import { crc32 } from "node:zlib";
import {
  ageInDays,
  ageingBucket,
  bucketise,
  daysOverdue,
  escalationLevelFor,
  median,
} from "./ageingEngine.js";
import {
  chainIsStranded,
  computeSubmitBy,
  firstPendingGroup,
  generateSubmittalSchedule,
  isCloseoutType,
  resolveFinalCode,
  resubmissionBySpecSection,
  reviewerTurnaround,
  submittalRisk,
} from "./submittalEngine.js";
import {
  applyTemplate,
  businessDaysBetween,
  carryForwardSections,
  complianceByCreator,
  consolidateLogs,
  mergeSections,
  normaliseAiSections,
  reconcileHours,
  renderDailyLogHtml,
} from "./dailyLogEngine.js";
import {
  fetchHistoricalWeather,
  parseOpenMeteoDaily,
  weatherCodeToConditions,
  type FetchLike,
} from "./weather.js";
import {
  authorisePunchTransition,
  completionStats,
  groupByLocation,
  toCsv,
  validateVerifierChange,
} from "./punchEngine.js";
import { exifDateToIso, extractExif, haversineKm, isValidPin, sniffMediaType } from "./photoEngine.js";
import { buildZip, listZip, uniqueZipNames } from "./zip.js";
import {
  detectCoApprovalPattern,
  detectPhotoDateDrift,
  detectPhotoOutsideGeofence,
  detectPunchSelfVerification,
  detectRfiEditedAfterAnswer,
  detectRfiSelfAnswer,
  detectRushedDailyLogApproval,
  detectSubmittalRubberStamp,
} from "./integrityEngine.js";
import { cleanSubject, detectRfiReference, htmlToText, parseAddress, parseInboundRfiEmail, stripQuotedReply } from "./emailIngest.js";
import { ballInCourtSummary, cycleTimeStats } from "./rfiEngine.js";

describe("ageing engine", () => {
  it("buckets ages and computes overdue days", () => {
    expect(ageingBucket(0)).toBe("0-7");
    expect(ageingBucket(7)).toBe("0-7");
    expect(ageingBucket(8)).toBe("8-14");
    expect(ageingBucket(14)).toBe("8-14");
    expect(ageingBucket(15)).toBe("15-30");
    expect(ageingBucket(31)).toBe("30+");
    expect(ageInDays("2026-08-01", "2026-08-11")).toBe(10);
    expect(ageInDays("2026-08-01T12:00:00Z", "2026-08-11")).toBe(9);
    expect(daysOverdue("2026-08-01", "2026-08-11")).toBe(10);
    expect(daysOverdue("2026-08-11", "2026-08-11")).toBe(0);
    expect(daysOverdue(null, "2026-08-11")).toBe(0);
  });

  it("bucketises by group with the heaviest group first", () => {
    const items = [
      { age: 2, who: "a" },
      { age: 20, who: "a" },
      { age: 40, who: "b" },
    ];
    const res = bucketise(items, (i) => i.age, (i) => i.who);
    expect(res.total).toBe(3);
    expect(res.buckets).toEqual({ "0-7": 1, "8-14": 0, "15-30": 1, "30+": 1 });
    expect(res.groups[0]!.key).toBe("a");
    expect(res.groups[0]!.buckets["15-30"]).toBe(1);
  });

  it("maps overdue days to escalation rungs", () => {
    expect(escalationLevelFor(0, 3)).toBe(0);
    expect(escalationLevelFor(1, 3)).toBe(1);
    expect(escalationLevelFor(3, 3)).toBe(2);
    expect(escalationLevelFor(6, 3)).toBe(3);
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("submittal engine", () => {
  it("back-computes submit-by with a configurable allowance", () => {
    expect(computeSubmitBy("2026-12-01", 30)).toBe("2026-10-18");
    expect(computeSubmitBy("2026-12-01", 30, 7)).toBe("2026-10-25");
    expect(computeSubmitBy(null, 30)).toBeNull();
  });

  it("resolves final codes by explicit precedence", () => {
    expect(resolveFinalCode(["approved", "for_record"])).toBe("approved");
    expect(resolveFinalCode(["for_record", "for_record"])).toBe("for_record");
    expect(resolveFinalCode(["approved", "approved_as_noted"])).toBe("approved_as_noted");
    expect(resolveFinalCode(["approved", "rejected", "approved_as_noted"])).toBe("rejected");
    expect(resolveFinalCode(["approved", "revise_and_resubmit"])).toBe("revise_and_resubmit");
    expect(resolveFinalCode([null, undefined])).toBeNull();
    // custom resubmit code outranks approvals
    expect(
      resolveFinalCode(["approved", "make_corrections"], [
        { code: "make_corrections", label: "Make corrections", isApproval: false, isResubmit: true, sortOrder: 0 },
      ]),
    ).toBe("make_corrections");
  });

  it("flags risk relative to today", () => {
    const base = { status: "open", requiredOnSite: "2026-12-01" };
    expect(submittalRisk({ ...base, submitByDate: "2026-09-10" }, "2026-09-01")).toBe("none");
    expect(submittalRisk({ ...base, submitByDate: "2026-09-05" }, "2026-09-01")).toBe("at_risk");
    expect(submittalRisk({ ...base, submitByDate: "2026-08-30" }, "2026-09-01")).toBe("late");
    expect(submittalRisk({ status: "open", submitByDate: null, requiredOnSite: "2026-08-01" }, "2026-09-01")).toBe(
      "required_on_site_passed",
    );
    expect(submittalRisk({ status: "responded", submitByDate: "2026-08-30", requiredOnSite: null }, "2026-09-01")).toBe("none");
  });

  it("finds the pending group and detects stranded chains", () => {
    const steps = [
      { id: "a", position: 0, reviewerId: "u1", responseCode: "approved" },
      { id: "b", position: 1, reviewerId: "u2", responseCode: null },
      { id: "c", position: 1, reviewerId: "u3", responseCode: null },
    ];
    expect(firstPendingGroup(steps)!.steps.map((s) => s.id)).toEqual(["b", "c"]);
    expect(chainIsStranded("in_review", steps)).toBe(false);
    expect(chainIsStranded("in_review", steps.map((s) => ({ ...s, responseCode: "approved" })))).toBe(true);
    expect(chainIsStranded("responded", [])).toBe(false);
  });

  it("segregates closeout types and generates a schedule from spec sections", () => {
    expect(isCloseoutType("o_and_m")).toBe(true);
    expect(isCloseoutType("shop_drawing")).toBe(false);
    const rows = generateSubmittalSchedule([
      { specSection: "08 44 13", title: "Curtain wall", submittalType: "shop_drawing", requiredOnSite: "2026-12-01", leadTimeDays: 30 },
      { specSection: "08 44 13", title: "curtain wall", requiredOnSite: "2026-12-01" },
      { specSection: "01 78 23", title: "O&M manuals", submittalType: "o_and_m" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.submitByDate).toBe("2026-10-18");
    expect(rows[1]!.submitByDate).toBeNull();
    expect(rows[1]!.reason).toMatch(/required-on-site/);
    expect(rows[1]!.isCloseout).toBe(true);
  });

  it("computes reviewer turnaround and resubmission rate", () => {
    const t = reviewerTurnaround(
      [
        { reviewerId: "u1", activatedAt: "2026-08-01T00:00:00Z", respondedAt: "2026-08-03T00:00:00Z", responseCode: "approved" },
        { reviewerId: "u1", activatedAt: "2026-08-01T00:00:00Z", respondedAt: null, responseCode: null },
        { reviewerId: "u2", activatedAt: "2026-08-10T00:00:00Z", respondedAt: null, responseCode: null },
      ],
      "2026-08-25T00:00:00Z",
      10,
    );
    const u1 = t.find((r) => r.reviewerId === "u1")!;
    expect(u1.avgDays).toBe(2);
    expect(u1.inCourt).toBe(1);
    expect(u1.overdueInCourt).toBe(1);
    const u2 = t.find((r) => r.reviewerId === "u2")!;
    expect(u2.oldestInCourtDays).toBe(15);
    const rate = resubmissionBySpecSection([
      { specSection: "08 44 13", number: 1, revision: 0 },
      { specSection: "08 44 13", number: 1, revision: 1 },
      { specSection: "08 44 13", number: 2, revision: 0 },
      { specSection: null, number: 3, revision: 0 },
    ]);
    expect(rate[0]).toEqual({ specSection: "08 44 13", submittals: 2, revisions: 1, rate: 0.5 });
  });
});

describe("daily log engine", () => {
  it("merges sections by key and clears with null", () => {
    const merged = mergeSections(
      { manpower: [{ company: "A", workers: 1, hours: 8 }], visitors: [{ name: "V" }] },
      { manpower: [{ company: "B", workers: 2, hours: 16 }], delays: null as unknown as undefined },
    );
    expect(merged["visitors"]).toEqual([{ name: "V" }]);
    expect((merged["manpower"] as unknown[])[0]).toEqual({ company: "B", workers: 2, hours: 16 });
    const cleared = mergeSections({ delays: [{ cause: "x" }] }, { delays: null });
    expect(cleared["delays"]).toBeUndefined();
  });

  it("normalises AI-drafted shapes", () => {
    const out = normaliseAiSections({
      delays: [{ description: "Crane down", durationHours: 2 }],
      manpower: [{ company: "Acme", workers: 3.4, hours: 24, activity: "Pour" }],
    });
    expect(out["delays"]).toEqual([{ cause: "Unclassified", description: "Crane down", hoursLost: 2 }]);
    expect(out["manpower"]).toEqual([{ company: "Acme", workers: 3, hours: 24, notes: "Pour" }]);
  });

  it("consolidates a site day across creators", () => {
    const day = consolidateLogs([
      { id: "1", createdBy: "u1", status: "approved", logKind: "internal", vendorId: null, weather: { tempC: 20 },
        sections: { manpower: [{ company: "Acme", workers: 5, hours: 40 }], delays: [{ cause: "Weather", description: "Rain", hoursLost: 2 }] } },
      { id: "2", createdBy: "u2", status: "submitted", logKind: "subcontractor", vendorId: "v1", weather: { tempC: 21 },
        sections: { manpower: [{ company: "Acme", workers: 2, hours: 16 }, { company: "Bolt", workers: 1, hours: 8 }] } },
      { id: "3", createdBy: "u3", status: "draft", logKind: "internal", vendorId: null, weather: null, sections: { manpower: [{ company: "X", workers: 9, hours: 90 }] } },
    ]);
    expect(day.logs).toBe(3);
    expect(day.submittedOrApproved).toBe(2);
    expect(day.totalWorkers).toBe(8);
    expect(day.totalHours).toBe(64);
    expect(day.manpower[0]).toEqual({ company: "Acme", workers: 7, hours: 56, sources: 2 });
    expect(day.totalHoursLost).toBe(2);
    expect(day.weather).toEqual({ tempC: 20 });
    expect(day.draftCreators).toEqual(["u3"]);
  });

  it("computes compliance per creator over business days", () => {
    expect(businessDaysBetween("2026-08-10", "2026-08-16")).toEqual(["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]);
    const rows = complianceByCreator(
      [
        { createdBy: "u1", logDate: "2026-08-10", status: "approved" },
        { createdBy: "u1", logDate: "2026-08-11", status: "submitted" },
        { createdBy: "u1", logDate: "2026-08-12", status: "draft" },
        { createdBy: "u2", logDate: "2026-08-12", status: "draft" },
      ],
      "2026-08-10",
      "2026-08-12",
    );
    const u1 = rows.find((r) => r.createdBy === "u1")!;
    expect(u1.expected).toBe(3);
    expect(u1.submitted).toBe(2);
    expect(u1.missing).toEqual(["2026-08-12"]);
    expect(u1.pct).toBe(66.7);
    expect(rows.find((r) => r.createdBy === "u2")!.submitted).toBe(0);
  });

  it("applies templates underneath and carries structure forward", () => {
    const applied = applyTemplate(
      { manpower: [{ company: "Acme", workers: 0, hours: 0 }], equipment: [{ name: "TC-1", hoursOperating: 0, hoursIdle: 0 }] },
      { manpower: [{ company: "Bolt", workers: 2, hours: 16 }] },
    );
    expect((applied["manpower"] as unknown[])[0]).toEqual({ company: "Bolt", workers: 2, hours: 16 });
    expect(applied["equipment"]).toHaveLength(1);
    const carried = carryForwardSections({
      manpower: [{ company: "Acme", workers: 5, hours: 40 }],
      equipment: [{ name: "TC-1", hoursOperating: 8, hoursIdle: 0 }],
      deliveries: [{ supplier: "S", description: "d" }],
    });
    expect(carried["manpower"]).toEqual([{ company: "Acme", workers: 0, hours: 0 }]);
    expect(carried["deliveries"]).toBeUndefined();
  });

  it("reconciles logged hours against timecards with a threshold", () => {
    const res = reconcileHours(
      new Map([["Acme", 100], ["Bolt", 8], ["Ghost", 12]]),
      new Map([["Acme", 80], ["Bolt", 8]]),
      15,
    );
    const acme = res.find((r) => r.key === "Acme")!;
    expect(acme.variancePct).toBe(25);
    expect(acme.flagged).toBe(true);
    expect(res.find((r) => r.key === "Bolt")!.flagged).toBe(false);
    const ghost = res.find((r) => r.key === "Ghost")!;
    expect(ghost.variancePct).toBeNull();
    expect(ghost.flagged).toBe(true);
  });

  it("renders escaped HTML", () => {
    const html = renderDailyLogHtml(
      { logDate: "2026-08-12", status: "approved", weather: { tempC: 20 }, weatherSource: "auto", logKind: "internal",
        sections: { manpower: [{ company: "<Acme>", workers: 1, hours: 8 }] }, notes: "a & b" },
      { projectName: "P1", creatorName: "Jane", approverName: "Bob", generatedAt: "2026-08-13T00:00:00Z" },
    );
    expect(html).toContain("&lt;Acme&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain("approved by Bob");
    expect(html).not.toContain("<Acme>");
  });
});

describe("weather adapter", () => {
  const body = {
    daily: {
      time: ["2026-08-12"],
      temperature_2m_max: [24.1],
      temperature_2m_min: [15.9],
      temperature_2m_mean: [19.8],
      precipitation_sum: [3.2],
      wind_speed_10m_max: [22.4],
      weather_code: [61],
    },
  };

  it("parses an Open-Meteo daily body", () => {
    const obs = parseOpenMeteoDaily(body, "2026-08-12")!;
    expect(obs.tempC).toBe(19.8);
    expect(obs.conditions).toBe("Rain");
    expect(obs.precipitationMm).toBe(3.2);
    expect(obs.windKph).toBe(22.4);
    expect(parseOpenMeteoDaily(body, "2026-08-13")).toBeNull();
    expect(parseOpenMeteoDaily({}, "2026-08-12")).toBeNull();
    expect(weatherCodeToConditions(0)).toBe("Clear");
    expect(weatherCodeToConditions(95)).toBe("Thunderstorm");
  });

  it("fetches through an injected client and never throws", async () => {
    const ok: FetchLike = async () => ({ ok: true, status: 200, json: async () => body });
    const capture = await fetchHistoricalWeather(
      { latitude: 51.5, longitude: -0.1, date: "2026-08-12" },
      { fetchImpl: ok, now: () => "2026-08-13T00:00:00Z" },
    );
    expect(capture?.provider).toBe("open-meteo");
    expect(capture?.observation.tempC).toBe(19.8);
    const failing: FetchLike = async () => {
      throw new Error("network down");
    };
    expect(await fetchHistoricalWeather({ latitude: 51.5, longitude: -0.1, date: "2026-08-12" }, { fetchImpl: failing })).toBeNull();
    const notOk: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    expect(await fetchHistoricalWeather({ latitude: 51.5, longitude: -0.1, date: "2026-08-12" }, { fetchImpl: notOk })).toBeNull();
    expect(await fetchHistoricalWeather({ latitude: null, longitude: -0.1, date: "2026-08-12" }, { fetchImpl: ok })).toBeNull();
    expect(await fetchHistoricalWeather({ latitude: 1, longitude: 1, date: "2026-08-12" }, { fetchImpl: ok, enabled: false })).toBeNull();
  });
});

describe("punch engine", () => {
  const item = {
    status: "ready_for_review",
    assigneeId: "asg",
    verifierId: "ver",
    createdBy: "cre",
    readyForReviewBy: "asg",
    afterPhotoIds: [] as string[],
  };

  it("enforces two-hands closure and admin-only void", () => {
    expect(authorisePunchTransition({ item, actorId: "ver", isAdmin: false, to: "closed" })).toEqual({ ok: true });
    expect(authorisePunchTransition({ item, actorId: "asg", isAdmin: false, to: "closed" }).ok).toBe(false);
    expect(authorisePunchTransition({ item: { ...item, verifierId: "asg" }, actorId: "asg", isAdmin: false, to: "closed" }).ok).toBe(false);
    expect(authorisePunchTransition({ item: { ...item, verifierId: null }, actorId: "cre", isAdmin: false, to: "closed" })).toEqual({ ok: true });
    expect(authorisePunchTransition({ item: { ...item, verifierId: null, createdBy: "asg" }, actorId: "asg", isAdmin: false, to: "closed" }).ok).toBe(false);
    const closed = authorisePunchTransition({ item: { ...item, status: "closed" }, actorId: "x", isAdmin: true, to: "void" });
    expect(closed.ok).toBe(false);
    expect(authorisePunchTransition({ item, actorId: "x", isAdmin: false, to: "void" })).toMatchObject({ ok: false, status: 403 });
    expect(authorisePunchTransition({ item: { ...item, status: "open" }, actorId: "x", isAdmin: false, to: "closed" })).toMatchObject({ ok: false, status: 400 });
  });

  it("gates ready_for_review on the assignee, a verifier and an after photo when configured", () => {
    const open = { ...item, status: "in_progress", readyForReviewBy: null };
    expect(authorisePunchTransition({ item: open, actorId: "asg", isAdmin: false, to: "ready_for_review" })).toEqual({ ok: true });
    expect(authorisePunchTransition({ item: open, actorId: "cre", isAdmin: false, to: "ready_for_review" }).ok).toBe(false);
    expect(
      authorisePunchTransition({ item: open, actorId: "asg", isAdmin: false, to: "ready_for_review", settings: { requireAfterPhoto: true } }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      authorisePunchTransition({ item: { ...open, verifierId: null }, actorId: "asg", isAdmin: false, to: "ready_for_review", settings: { requireVerifier: true } }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it("locks and validates verifier changes", () => {
    expect(validateVerifierChange({ item: { status: "open", verifierId: null, assigneeId: "asg" }, nextVerifierId: "asg", nextAssigneeId: undefined, actorId: "cre", isAdmin: false }).ok).toBe(false);
    expect(validateVerifierChange({ item: { status: "ready_for_review", verifierId: "ver", assigneeId: "asg" }, nextVerifierId: "other", nextAssigneeId: undefined, actorId: "cre", isAdmin: false })).toMatchObject({ ok: false, status: 403 });
    expect(validateVerifierChange({ item: { status: "open", verifierId: null, assigneeId: "asg" }, nextVerifierId: "asg", nextAssigneeId: undefined, actorId: "asg", isAdmin: false }).ok).toBe(false);
    expect(validateVerifierChange({ item: { status: "open", verifierId: null, assigneeId: "asg" }, nextVerifierId: "ver", nextAssigneeId: undefined, actorId: "cre", isAdmin: false })).toEqual({ ok: true });
  });

  it("groups by location tree and computes completion", () => {
    const locations = [
      { id: "b", name: "Building A", parentId: null, path: "b" },
      { id: "l3", name: "Level 3", parentId: "b", path: "b/l3" },
    ];
    const groups = groupByLocation(
      [
        { id: "1", locationId: "l3", status: "open" },
        { id: "2", locationId: "l3", status: "closed" },
        { id: "3", locationId: null, status: "open" },
      ],
      locations,
    );
    expect(groups[0]!.pathLabel).toBe("Building A / Level 3");
    expect(groups[0]!.counts.open).toBe(1);
    expect(groups[1]!.locationId).toBeNull();
    const stats = completionStats(
      [
        { status: "closed", createdAt: "2026-08-01T00:00:00Z", closedAt: "2026-08-05T00:00:00Z", dueDate: null },
        { status: "open", createdAt: "2026-08-01T00:00:00Z", closedAt: null, dueDate: "2026-08-02" },
        { status: "void", createdAt: "2026-08-01T00:00:00Z", closedAt: null, dueDate: null },
      ],
      "2026-08-10",
    );
    expect(stats.total).toBe(2);
    expect(stats.completionPct).toBe(50);
    expect(stats.avgDaysToClose).toBe(4);
    expect(stats.overdue).toBe(1);
    expect(toCsv([{ a: 'x,"y"', b: 1 }], [{ key: "a", header: "A" }, { key: "b", header: "B" }])).toBe('A,B\r\n"x,""y""",1\r\n');
  });
});

/** Build a JPEG with an EXIF APP1 (little-endian) carrying date, GPS, orientation. */
function jpegWithExif(): Buffer {
  const entries: Buffer[] = [];
  const data: Buffer[] = [];
  const IFD0_COUNT = 4;
  const ifd0Start = 8;
  const ifd0Size = 2 + IFD0_COUNT * 12 + 4;
  let dataCursor = ifd0Start + ifd0Size;
  const entry = (tag: number, type: number, count: number, value: Buffer): Buffer => {
    const e = Buffer.alloc(12);
    e.writeUInt16LE(tag, 0);
    e.writeUInt16LE(type, 2);
    e.writeUInt32LE(count, 4);
    if (value.length <= 4) value.copy(e, 8);
    else {
      e.writeUInt32LE(dataCursor, 8);
      data.push(value);
      dataCursor += value.length;
    }
    return e;
  };
  const short = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const long = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const rational = (n: number, d: number) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(n, 0);
    b.writeUInt32LE(d, 4);
    return b;
  };
  // IFD0: orientation, make (ascii > 4), ExifIFD ptr, GPS ptr — pointers filled after sizes known.
  const make = Buffer.from("Canon\0", "latin1");
  const exifIfdSize = 2 + 1 * 12 + 4;
  const gpsIfdSize = 2 + 4 * 12 + 4;
  // Layout: ifd0 | make | exifIfd | dateTime | gpsIfd | lat | lng
  const makeOffset = ifd0Start + ifd0Size;
  const exifIfdOffset = makeOffset + make.length;
  const dateTime = Buffer.from("2026:08:12 14:30:15\0", "latin1");
  const dateOffset = exifIfdOffset + exifIfdSize;
  const gpsIfdOffset = dateOffset + dateTime.length;
  const latOffset = gpsIfdOffset + gpsIfdSize;
  const lat = Buffer.concat([rational(51, 1), rational(30, 1), rational(0, 1)]);
  const lng = Buffer.concat([rational(0, 1), rational(7, 1), rational(3960, 100)]);
  const lngOffset = latOffset + lat.length;

  const e = (tag: number, type: number, count: number, inline: Buffer, offset?: number): Buffer => {
    const b = Buffer.alloc(12);
    b.writeUInt16LE(tag, 0);
    b.writeUInt16LE(type, 2);
    b.writeUInt32LE(count, 4);
    if (offset !== undefined) b.writeUInt32LE(offset, 8);
    else inline.copy(b, 8);
    return b;
  };
  const ifd0 = Buffer.concat([
    short(IFD0_COUNT),
    e(0x010f, 2, make.length, Buffer.alloc(0), makeOffset),
    e(0x0112, 3, 1, short(6)),
    e(0x8769, 4, 1, long(exifIfdOffset)),
    e(0x8825, 4, 1, long(gpsIfdOffset)),
    long(0),
  ]);
  const exifIfd = Buffer.concat([short(1), e(0x9003, 2, dateTime.length, Buffer.alloc(0), dateOffset), long(0)]);
  const gpsIfd = Buffer.concat([
    short(4),
    e(0x0001, 2, 2, Buffer.from("N\0\0\0", "latin1")),
    e(0x0002, 5, 3, Buffer.alloc(0), latOffset),
    e(0x0003, 2, 2, Buffer.from("W\0\0\0", "latin1")),
    e(0x0004, 5, 3, Buffer.alloc(0), lngOffset),
    long(0),
  ]);
  const tiffHeader = Buffer.concat([Buffer.from("II", "latin1"), short(0x2a), long(ifd0Start)]);
  const tiff = Buffer.concat([tiffHeader, ifd0, make, exifIfd, dateTime, gpsIfd, lat, lng]);
  const app1Body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), short(app1Body.length + 2).reverse(), app1Body]);
  void entries;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}

describe("photo engine", () => {
  it("sniffs media types from magic bytes", () => {
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffMediaType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toBe("image/webp");
    expect(sniffMediaType(Buffer.from("\0\0\0\x18ftypheic\0\0\0\0", "latin1"))).toBe("image/heic");
    expect(sniffMediaType(Buffer.from("\0\0\0\x18ftypisom\0\0\0\0", "latin1"))).toBe("video/mp4");
    expect(sniffMediaType(Buffer.from("%PDF-1.4 hello world", "latin1"))).toBeNull();
    expect(sniffMediaType(Buffer.from([1, 2]))).toBeNull();
  });

  it("extracts EXIF date, GPS and orientation from a JPEG", () => {
    const exif = extractExif(jpegWithExif())!;
    expect(exif).not.toBeNull();
    expect(exif.takenAt).toBe("2026-08-12T14:30:15.000Z");
    expect(exif.orientation).toBe(6);
    expect(exif.make).toBe("Canon");
    expect(exif.latitude).toBeCloseTo(51.5, 4);
    expect(exif.longitude).toBeCloseTo(-(7 / 60 + 39.6 / 3600), 4);
    expect(extractExif(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(extractExif(Buffer.from("not a jpeg"))).toBeNull();
    // truncated: never throws
    expect(extractExif(jpegWithExif().subarray(0, 40))).toBeNull();
    expect(exifDateToIso("0000:00:00 00:00:00")).toBeUndefined();
    expect(exifDateToIso("2026:01:02 03:04:05", "+02:00")).toBe("2026-01-02T01:04:05.000Z");
  });

  it("measures distance and validates pins", () => {
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeCloseTo(343.5, 0);
    expect(isValidPin({ sheetId: "s1", x: 0.5, y: 0.2 })).toBe(true);
    expect(isValidPin({ sheetId: "s1", x: 1.5, y: 0.2 })).toBe(false);
    expect(isValidPin(null)).toBe(false);
  });
});

describe("zip writer", () => {
  it("builds a store-only archive with a valid central directory", () => {
    const a = Buffer.from("hello");
    const b = Buffer.from("world!!");
    const zip = buildZip([
      { name: "a.txt", data: a, mtime: new Date("2026-08-12T10:00:00Z") },
      { name: "a.txt", data: b, mtime: new Date("2026-08-12T10:00:00Z") },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const entries = listZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "a (2).txt"]);
    expect(entries[0]!.crc).toBe(crc32(a) >>> 0);
    expect(entries[1]!.size).toBe(b.length);
    // local header offset points at a local header signature
    expect(zip.readUInt32LE(entries[1]!.offset)).toBe(0x04034b50);
    expect(uniqueZipNames(["x", "x", "../x"])).toEqual(["x", "x (2)", "x (3)"]);
  });
});

describe("integrity detectors", () => {
  it("flags self-answered and post-answer edited RFIs", () => {
    expect(detectRfiSelfAnswer({ number: 1, createdBy: "u", respondedBy: "u", status: "answered" })?.detector).toBe("field_rfi_self_answered");
    expect(detectRfiSelfAnswer({ number: 1, createdBy: "u", respondedBy: "v", status: "answered" })).toBeNull();
    expect(detectRfiEditedAfterAnswer({ number: 1, status: "answered", officialResponse: "x" }, ["question"])?.severity).toBe("high");
    expect(detectRfiEditedAfterAnswer({ number: 1, status: "open", officialResponse: null }, ["question"])).toBeNull();
    expect(detectRfiEditedAfterAnswer({ number: 1, status: "answered", officialResponse: "x" }, ["dueDate"])).toBeNull();
  });

  it("flags punch self-verification and rushed approvals", () => {
    expect(detectPunchSelfVerification({ number: 1, status: "closed", assigneeId: "a", verifierId: "a", readyForReviewBy: "a", closedBy: "a" })?.severity).toBe("high");
    expect(detectPunchSelfVerification({ number: 1, status: "closed", assigneeId: "a", verifierId: "v", readyForReviewBy: "a", closedBy: "v" })).toBeNull();
    expect(detectRushedDailyLogApproval({ logDate: "2026-08-12", submittedAt: "2026-08-12T10:00:00Z", approvedAt: "2026-08-12T10:00:20Z", createdBy: "a", approvedBy: "b" })).not.toBeNull();
    expect(detectRushedDailyLogApproval({ logDate: "2026-08-12", submittedAt: "2026-08-12T10:00:00Z", approvedAt: "2026-08-12T10:05:00Z", createdBy: "a", approvedBy: "b" })).toBeNull();
    const logs = Array.from({ length: 10 }, () => ({ createdBy: "a", approvedBy: "b" }));
    expect(detectCoApprovalPattern(logs)).not.toBeNull();
    expect(detectCoApprovalPattern([...logs, { createdBy: "a", approvedBy: "c" }])).toBeNull();
  });

  it("flags rubber-stamp submittals and suspicious photos", () => {
    const sub = { number: 3, revision: 0, status: "responded", responseCode: "approved", submittedAt: "2026-08-12T09:00:00Z", respondedAt: "2026-08-12T10:00:00Z" };
    expect(detectSubmittalRubberStamp(sub, [{ comments: null, responseCode: "approved" }])).not.toBeNull();
    expect(detectSubmittalRubberStamp(sub, [{ comments: "checked anchors", responseCode: "approved" }])).toBeNull();
    expect(detectSubmittalRubberStamp({ ...sub, respondedAt: "2026-08-14T10:00:00Z" }, [{ comments: null, responseCode: "approved" }])).toBeNull();
    expect(detectPhotoDateDrift({ id: "p", takenAt: "2026-07-01T00:00:00Z", createdAt: "2026-08-12T00:00:00Z" })).not.toBeNull();
    expect(detectPhotoDateDrift({ id: "p", takenAt: "2026-08-10T00:00:00Z", createdAt: "2026-08-12T00:00:00Z" })).toBeNull();
    expect(detectPhotoOutsideGeofence({ id: "p", latitude: 48.85, longitude: 2.35 }, { latitude: 51.5, longitude: -0.12 })).not.toBeNull();
    expect(detectPhotoOutsideGeofence({ id: "p", latitude: 51.51, longitude: -0.12 }, { latitude: 51.5, longitude: -0.12 })).toBeNull();
    expect(detectPhotoOutsideGeofence({ id: "p", latitude: null, longitude: null }, { latitude: 51.5, longitude: -0.12 })).toBeNull();
  });
});

describe("email ingestion parser", () => {
  it("parses addresses, subjects and references", () => {
    expect(parseAddress('"Jane Doe" <Jane@X.com>')).toEqual({ email: "jane@x.com", name: "Jane Doe" });
    expect(parseAddress("bob@site.dev")).toEqual({ email: "bob@site.dev", name: null });
    expect(detectRfiReference("Re: RFI-012: Rebar")).toBe(12);
    expect(detectRfiReference("RFI #7 question")).toBe(7);
    expect(detectRfiReference("No reference here")).toBeNull();
    expect(cleanSubject("Re: Fwd: RFI-012: Rebar spacing")).toBe("Rebar spacing");
    expect(cleanSubject("Re:")).toBe("Inbound RFI");
  });

  it("converts html and strips quoted replies", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b></p><p>Second</p>")).toBe("Hello world\nSecond");
    expect(stripQuotedReply("New question\n\nOn Tue, Bob wrote:\n> old stuff")).toBe("New question");
    const parsed = parseInboundRfiEmail({
      from: "Site Eng <eng@sub.com>",
      subject: "RE: RFI-004 slab edge",
      html: "<div>Which detail governs?</div>",
      attachments: [{ fileId: "fil_1" }, { filename: "no-id.pdf" }],
    });
    expect(parsed.replyToNumber).toBe(4);
    expect(parsed.subject).toBe("slab edge");
    expect(parsed.question).toBe("Which detail governs?");
    expect(parsed.senderEmail).toBe("eng@sub.com");
    expect(parsed.fileIds).toEqual(["fil_1"]);
  });
});

describe("rfi analytics", () => {
  it("measures cycle time from issue and reports the basis", () => {
    const stats = cycleTimeStats([
      { issuedAt: "2026-08-01T00:00:00Z", createdAt: "2026-07-20T00:00:00Z", respondedAt: "2026-08-05T00:00:00Z" },
      { issuedAt: null, createdAt: "2026-08-01T00:00:00Z", respondedAt: "2026-08-03T00:00:00Z" },
      { issuedAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", respondedAt: null },
    ]);
    expect(stats.n).toBe(2);
    expect(stats.avgResponseDays).toBe(3);
    expect(stats.measuredFromCreated).toBe(1);
    expect(stats.basis).toMatch(/legacy/);
  });

  it("summarises ball in court", () => {
    const rows = ballInCourtSummary(
      [
        { ballInCourtId: "u1", status: "open", issuedAt: "2026-08-01T00:00:00Z", createdAt: "2026-08-01T00:00:00Z", dueDate: "2026-08-05", updatedAt: "" },
        { ballInCourtId: "u1", status: "open", issuedAt: null, createdAt: "2026-08-08T00:00:00Z", dueDate: "2026-09-05", updatedAt: "" },
        { ballInCourtId: "u2", status: "answered", issuedAt: null, createdAt: "2026-08-08T00:00:00Z", dueDate: null, updatedAt: "" },
      ],
      "2026-08-11",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u1", open: 2, overdue: 1, oldestDays: 10 });
  });
});
