import { describe, expect, it } from "vitest";
import { parseXer, parseXerCalendarData, parseXerTables } from "./xer.js";
import { durationHours, exportMspdi, parseMspdi, xmlBlocks, xmlValue } from "./mspdi.js";
import { diffRevisions, type DiffTask } from "./diff.js";
import { computeCpm2, type CalendarSpec } from "../cpm2.js";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const WEEK =
  "(0||CalendarData()(0||DaysOfWeek()" +
  "(0||1())" +
  "(0||2()(0||0(s|08:00|f|17:00)))" +
  "(0||3()(0||0(s|08:00|f|17:00)))" +
  "(0||4()(0||0(s|08:00|f|17:00)))" +
  "(0||5()(0||0(s|08:00|f|17:00)))" +
  "(0||6()(0||0(s|08:00|f|17:00)))" +
  "(0||7())" +
  ")(0||Exceptions()(0||0(d|46029)))))";

const XER = [
  "ERMHDR\t19.12\t2026-01-05\tProject\tadmin\tadmin\tPrimavera\tProject Management\tUSD",
  "%T\tPROJECT",
  "%F\tproj_id\tproj_short_name\tplan_start_date\tlast_recalc_date",
  "%R\t1000\tTOWER-A\t2026-01-05 00:00\t2026-02-02 00:00",
  "%T\tCALENDAR",
  "%F\tclndr_id\tdefault_flag\tclndr_name\tday_hr_cnt\tclndr_data",
  `%R\t1\tY\tStandard 5 Day\t8\t${WEEK}`,
  "%T\tPROJWBS",
  "%F\twbs_id\tparent_wbs_id\twbs_short_name",
  "%R\t10\t\tTOWER",
  "%R\t11\t10\tSUB",
  "%T\tRSRC",
  "%F\trsrc_id\trsrc_name\trsrc_short_name\trsrc_type",
  "%R\t500\tSteel Fixers\tSF\tRT_Labor",
  "%T\tTASK",
  "%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\ttarget_drtn_hr_cnt\tremain_drtn_hr_cnt\tact_start_date\tact_end_date\tphys_complete_pct\tcstr_type\tcstr_date\ttarget_start_date\ttarget_end_date",
  "%R\t2001\t1000\t10\t1\tA1000\tMobilise\tTT_Task\t40\t0\t2026-01-05 08:00\t2026-01-09 17:00\t100\t\t\t2026-01-05 08:00\t2026-01-09 17:00",
  "%R\t2002\t1000\t11\t1\tA1010\tPiling\tTT_Task\t80\t40\t2026-01-12 08:00\t\t50\t\t\t2026-01-12 08:00\t2026-01-23 17:00",
  "%R\t2003\t1000\t11\t1\tA1020\tPile caps\tTT_Task\t120\t120\t\t\t0\tCS_MSOA\t2026-02-02 08:00\t2026-01-26 08:00\t2026-02-10 17:00",
  "%R\t2004\t1000\t10\t1\tM1000\tStructure complete\tTT_FinMile\t0\t0\t\t\t0\t\t\t2026-02-11 08:00\t2026-02-11 08:00",
  "%T\tTASKPRED",
  "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
  "%R\t9001\t2002\t2001\tPR_FS\t0",
  "%R\t9002\t2003\t2002\tPR_FS\t16",
  "%R\t9003\t2004\t2003\tPR_FS\t0",
  "%T\tTASKRSRC",
  "%F\ttaskrsrc_id\ttask_id\trsrc_id\trsrc_type\ttarget_qty\tremain_qty\tact_reg_qty\tcost_per_qty\ttarget_cost\tact_reg_cost",
  "%R\t7001\t2002\t500\tRT_Labor\t320\t160\t160\t45\t14400\t7200",
  "%E",
  "",
].join("\n");

const MSPDI = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <UID>{abc}</UID>
  <Name>Tower A.mpp</Name>
  <Title>Tower A</Title>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <CurrentDate>2026-02-02T08:00:00</CurrentDate>
  <CalendarUID>1</CalendarUID>
  <Calendars>
    <Calendar>
      <UID>1</UID>
      <Name>Standard</Name>
      <IsBaseCalendar>1</IsBaseCalendar>
      <WeekDays>
        <WeekDay><DayType>1</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>3</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>4</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>5</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>6</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>16:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>
        <WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
        <WeekDay><DayType>0</DayType><DayWorking>0</DayWorking><TimePeriod><FromDate>2026-01-07T00:00:00</FromDate><ToDate>2026-01-07T23:59:00</ToDate></TimePeriod></WeekDay>
      </WeekDays>
    </Calendar>
  </Calendars>
  <Tasks>
    <Task><UID>0</UID><Name>Tower A</Name><Summary>1</Summary><Duration>PT200H0M0S</Duration></Task>
    <Task>
      <UID>1</UID><ID>1</ID><Name>Mobilise &amp; set up</Name><WBS>1.1</WBS>
      <OutlineNumber>1.1</OutlineNumber><Duration>PT40H0M0S</Duration>
      <Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T16:00:00</Finish>
      <ActualStart>2026-01-05T08:00:00</ActualStart><ActualFinish>2026-01-09T16:00:00</ActualFinish>
      <PercentComplete>100</PercentComplete><Milestone>0</Milestone><Summary>0</Summary>
    </Task>
    <Task>
      <UID>2</UID><ID>2</ID><Name>Piling</Name><WBS>1.2</WBS>
      <Duration>PT80H0M0S</Duration><RemainingDuration>PT40H0M0S</RemainingDuration>
      <Start>2026-01-12T08:00:00</Start><Finish>2026-01-23T16:00:00</Finish>
      <ActualStart>2026-01-12T08:00:00</ActualStart>
      <PercentComplete>50</PercentComplete>
      <ConstraintType>4</ConstraintType><ConstraintDate>2026-01-12T08:00:00</ConstraintDate>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
    <Task>
      <UID>3</UID><ID>3</ID><Name>Structure complete</Name><WBS>1.3</WBS>
      <Duration>PT0H0M0S</Duration><Milestone>1</Milestone>
      <Start>2026-02-11T08:00:00</Start><Finish>2026-02-11T08:00:00</Finish>
      <PercentComplete>0</PercentComplete>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>9600</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
  </Tasks>
</Project>`;

/* ------------------------------------------------------------------ */
/* XER                                                                 */
/* ------------------------------------------------------------------ */

describe("P6 XER importer (#349)", () => {
  it("splits the tab-delimited tables", () => {
    const tables = parseXerTables(XER);
    expect(tables.map((t) => t.name)).toEqual([
      "PROJECT",
      "CALENDAR",
      "PROJWBS",
      "RSRC",
      "TASK",
      "TASKPRED",
      "TASKRSRC",
    ]);
    expect(tables.find((t) => t.name === "TASK")!.rows).toHaveLength(4);
  });

  it("reads the working week and holidays out of clndr_data", () => {
    const parsed = parseXerCalendarData(WEEK);
    expect(parsed.workdays).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(parsed.holidays).toEqual(["2026-01-07"]);
  });

  it("maps activities, durations, actuals, constraints and the WBS path", () => {
    const p = parseXer(XER);
    expect(p.format).toBe("xer");
    expect(p.projectName).toBe("TOWER-A");
    expect(p.projectStart).toBe("2026-01-05");
    expect(p.dataDate).toBe("2026-02-02");
    expect(p.tasks).toHaveLength(4);

    const piling = p.tasks.find((t) => t.wbsCode === "A1010")!;
    expect(piling.name).toBe("Piling");
    expect(piling.durationDays).toBe(10); // 80h / 8h
    expect(piling.remainingDurationDays).toBe(5);
    expect(piling.actualStart).toBe("2026-01-12");
    expect(piling.actualFinish).toBeNull();
    expect(piling.percentComplete).toBe(50);
    expect(piling.wbsPath).toBe("TOWER.SUB");

    const caps = p.tasks.find((t) => t.wbsCode === "A1020")!;
    expect(caps.constraintType).toBe("start_no_earlier_than");
    expect(caps.constraintDate).toBe("2026-02-02");

    const milestone = p.tasks.find((t) => t.wbsCode === "M1000")!;
    expect(milestone.taskType).toBe("finish_milestone");
    expect(milestone.durationDays).toBe(0);
  });

  it("maps relationship types and converts hour lags to days", () => {
    const p = parseXer(XER);
    expect(p.dependencies).toHaveLength(3);
    const lagged = p.dependencies.find((d) => d.predecessorExternalId === "2002")!;
    expect(lagged.depType).toBe("FS");
    expect(lagged.lagDays).toBe(2); // 16h / 8h
  });

  it("imports resource assignments (#370)", () => {
    const p = parseXer(XER);
    expect(p.resources).toHaveLength(1);
    expect(p.resources[0]).toMatchObject({
      taskExternalId: "2002",
      name: "Steel Fixers",
      resourceType: "labour",
      budgetedUnits: 320,
      actualUnits: 160,
      budgetedCost: 14400,
    });
  });

  it("refuses a file that is not an XER", () => {
    expect(() => parseXer("hello,world\n1,2")).toThrow(/not a readable xer/i);
  });

  it("warns rather than guessing when the calendar cannot be read", () => {
    const noCal = XER.replace(WEEK, "garbage");
    const p = parseXer(noCal);
    expect(p.warnings.join(" ")).toMatch(/working-week data/i);
    expect(p.calendars[0]!.workdays).toEqual([0, 1, 1, 1, 1, 1, 0]);
  });

  it("feeds the CPM2 engine so imported dates reproduce", () => {
    const p = parseXer(XER);
    const cals: CalendarSpec[] = p.calendars.map((c) => ({
      id: c.externalId,
      workdays: c.workdays,
      holidays: c.holidays,
      exceptions: c.exceptions,
      hoursPerDay: c.hoursPerDay,
    }));
    const res = computeCpm2(
      p.tasks.map((t) => ({
        id: t.externalId,
        duration: t.durationDays,
        remainingDuration: t.remainingDurationDays,
        percentComplete: t.percentComplete,
        constraintType: t.constraintType,
        constraintDate: t.constraintDate,
        actualStart: t.actualStart,
        actualFinish: t.actualFinish,
        calendarId: t.calendarExternalId,
        taskType: t.taskType,
      })),
      p.dependencies.map((d) => ({
        predecessorId: d.predecessorExternalId,
        successorId: d.successorExternalId,
        type: d.depType,
        lagDays: d.lagDays,
      })),
      { projectStart: p.projectStart, dataDate: p.dataDate, calendars: cals, defaultCalendarId: "1" },
    );
    expect(res.ok).toBe(true);
    // Mobilise is complete and keeps its actual dates.
    expect(res.tasks.get("2001")!.finishDate).toBe("2026-01-09");
    // Piling has 5 remaining working days from the 2 Feb data date.
    expect(res.tasks.get("2002")!.finishDate).toBe("2026-02-06");
    expect(res.projectFinishDate).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* MSPDI                                                               */
/* ------------------------------------------------------------------ */

describe("MS Project MSPDI importer (#350)", () => {
  it("parses nested blocks and decodes entities", () => {
    expect(xmlBlocks("<a><b>1</b><b>2</b></a>", "b")).toEqual(["1", "2"]);
    expect(xmlValue("<Name>A &amp; B</Name>", "Name")).toBe("A & B");
    expect(durationHours("PT40H30M0S")).toBeCloseTo(40.5, 5);
    expect(durationHours("nonsense")).toBeNull();
  });

  it("reads the header, calendar and status date", () => {
    const p = parseMspdi(MSPDI);
    expect(p.format).toBe("mspdi");
    expect(p.projectName).toBe("Tower A");
    expect(p.projectStart).toBe("2026-01-05");
    expect(p.dataDate).toBe("2026-02-02");
    expect(p.calendars).toHaveLength(1);
    expect(p.calendars[0]!.workdays).toEqual([0, 1, 1, 1, 1, 1, 0]);
    expect(p.calendars[0]!.hoursPerDay).toBe(8);
    expect(p.calendars[0]!.holidays).toEqual(["2026-01-07"]);
  });

  it("skips the project summary row and maps tasks", () => {
    const p = parseMspdi(MSPDI);
    expect(p.tasks.map((t) => t.externalId)).toEqual(["1", "2", "3"]);
    expect(p.tasks[0]!.name).toBe("Mobilise & set up");
    expect(p.tasks[0]!.durationDays).toBe(5);
    expect(p.tasks[0]!.actualFinish).toBe("2026-01-09");
    expect(p.tasks[1]!.remainingDurationDays).toBe(5);
    expect(p.tasks[1]!.constraintType).toBe("start_no_earlier_than");
    expect(p.tasks[2]!.taskType).toBe("start_milestone");
    expect(p.tasks[2]!.durationDays).toBe(0);
  });

  it("maps PredecessorLink types correctly and converts tenths-of-minutes lag", () => {
    const p = parseMspdi(MSPDI);
    expect(p.dependencies).toHaveLength(2);
    expect(p.dependencies[0]).toMatchObject({ predecessorExternalId: "1", successorExternalId: "2", depType: "FS" });
    // 9600 tenths of a minute = 16 hours = 2 days on an 8h calendar
    expect(p.dependencies[1]!.lagDays).toBe(2);
  });

  it("maps link type 0 to FF and 3 to SS, not FS", () => {
    const xml = MSPDI.replace("<Type>1</Type><LinkLag>0</LinkLag>", "<Type>0</Type><LinkLag>0</LinkLag>");
    const p = parseMspdi(xml);
    expect(p.dependencies[0]!.depType).toBe("FF");
    const xml2 = MSPDI.replace("<Type>1</Type><LinkLag>0</LinkLag>", "<Type>3</Type><LinkLag>0</LinkLag>");
    expect(parseMspdi(xml2).dependencies[0]!.depType).toBe("SS");
  });

  it("refuses a file that is not MSPDI", () => {
    expect(() => parseMspdi("<html><body>no</body></html>")).toThrow(/not a readable ms project/i);
  });

  it("round-trips through the exporter", () => {
    const xml = exportMspdi({
      name: "Tower A",
      projectStart: "2026-01-05",
      dataDate: "2026-02-02",
      hoursPerDay: 8,
      tasks: [
        {
          id: "t1",
          name: "Mobilise & set up",
          wbsCode: "1.1",
          durationDays: 5,
          startDate: "2026-01-05",
          finishDate: "2026-01-09",
          actualStart: "2026-01-05",
          actualFinish: "2026-01-09",
          percentComplete: 100,
          taskType: "task",
          totalFloat: 0,
          isCritical: true,
          sortOrder: 0,
        },
        {
          id: "t2",
          name: "Piling",
          wbsCode: "1.2",
          durationDays: 10,
          startDate: "2026-01-12",
          finishDate: "2026-01-23",
          actualStart: null,
          actualFinish: null,
          percentComplete: 0,
          taskType: "task",
          totalFloat: 3,
          isCritical: false,
          sortOrder: 1,
        },
      ],
      dependencies: [{ predecessorId: "t1", successorId: "t2", depType: "FS", lagDays: 2 }],
    });
    const back = parseMspdi(xml);
    expect(back.tasks).toHaveLength(2);
    expect(back.tasks[0]!.name).toBe("Mobilise & set up");
    expect(back.tasks[1]!.durationDays).toBe(10);
    expect(back.dependencies[0]).toMatchObject({ depType: "FS", lagDays: 2 });
    expect(back.dataDate).toBe("2026-02-02");
  });
});

/* ------------------------------------------------------------------ */
/* Revision diff                                                       */
/* ------------------------------------------------------------------ */

describe("revision diff (#357)", () => {
  const base: DiffTask[] = [
    { id: "a", externalId: "1", name: "Mobilise", durationDays: 5, startDate: "2026-01-05", finishDate: "2026-01-09", percentComplete: 0, isCritical: true },
    { id: "b", externalId: "2", name: "Piling", durationDays: 10, startDate: "2026-01-12", finishDate: "2026-01-23", percentComplete: 0, isCritical: true },
    { id: "c", externalId: "3", name: "Cladding", durationDays: 4, startDate: "2026-02-02", finishDate: "2026-02-05", percentComplete: 0, isCritical: false },
  ];

  it("detects added, removed, retimed, lengthened and progressed activities", () => {
    const next: DiffTask[] = [
      { ...base[0]!, id: "a2", percentComplete: 100 },
      { ...base[1]!, id: "b2", durationDays: 15, startDate: "2026-01-12", finishDate: "2026-01-30" },
      { id: "d2", externalId: "4", name: "Piling remedial", durationDays: 3, startDate: "2026-02-02", finishDate: "2026-02-04", percentComplete: 0, isCritical: true },
    ];
    const d = diffRevisions(
      { tasks: base, dependencies: [{ predecessorId: "a", successorId: "b", depType: "FS", lagDays: 0 }] },
      { tasks: next, dependencies: [{ predecessorId: "a2", successorId: "b2", depType: "SS", lagDays: 3 }] },
    );
    expect(d.addedTasks.map((t) => t.name)).toEqual(["Piling remedial"]);
    expect(d.removedTasks.map((t) => t.name)).toEqual(["Cladding"]);
    expect(d.durationChanges).toHaveLength(1);
    expect(d.durationChanges[0]).toMatchObject({ name: "Piling", fromDays: 10, toDays: 15, deltaDays: 5 });
    expect(d.dateChanges.map((c) => c.name)).toEqual(["Piling"]);
    expect(d.dateChanges[0]!.finishDeltaDays).toBe(7);
    expect(d.progressChanges[0]).toMatchObject({ name: "Mobilise", fromPercent: 0, toPercent: 100 });
    expect(d.logicChanged[0]).toMatchObject({ fromType: "FS", toType: "SS", fromLagDays: 0, toLagDays: 3 });
    expect(d.totals).toMatchObject({ from: 3, to: 3, added: 1, removed: 1, durationChanged: 1 });
  });

  it("matches on wbsCode + name when no external id exists, and flags collisions", () => {
    const from: DiffTask[] = [{ id: "x", name: "Slab", wbsCode: "A", durationDays: 2 }];
    const to: DiffTask[] = [
      { id: "y", name: "Slab", wbsCode: "A", durationDays: 4 },
      { id: "z", name: "Slab", wbsCode: "A", durationDays: 6 },
    ];
    const d = diffRevisions({ tasks: from, dependencies: [] }, { tasks: to, dependencies: [] });
    expect(d.durationChanges).toHaveLength(1);
    expect(d.duplicateKeys).toEqual(["w:A|Slab"]);
  });

  it("reports added and removed logic separately from retyped logic", () => {
    const d = diffRevisions(
      { tasks: base, dependencies: [{ predecessorId: "a", successorId: "b", depType: "FS", lagDays: 0 }] },
      { tasks: base, dependencies: [{ predecessorId: "b", successorId: "c", depType: "FS", lagDays: 0 }] },
    );
    expect(d.logicAdded).toHaveLength(1);
    expect(d.logicRemoved).toHaveLength(1);
    expect(d.logicChanged).toHaveLength(0);
  });
});
