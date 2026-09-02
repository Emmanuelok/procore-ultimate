import { describe, expect, it } from "vitest";
import {
  normaliseDate,
  parseMspDuration,
  parseMspXml,
  parseProgramme,
  parseXer,
  parseXerTables,
  sniffProgramme,
  topoOrder,
  type ProgrammeTaskRow,
} from "./programme.js";

/**
 * Programme importer unit tests (#349-350).
 *
 * The fixtures are cut down but structurally exact: XER is a tab-delimited
 * record stream with %T/%F/%R tags, MSP XML is `<Task>` elements with nested
 * `<PredecessorLink>`. What is asserted is not "it parses" but the three things
 * a forensic module depends on — the ACTIVITIES, the LOGIC (type and lag) and
 * the honest CAVEATS about what was not imported.
 */

const XER = [
  "ERMHDR\t19.12\t2026-08-01\tProject\tadmin",
  "%T\tPROJECT",
  "%F\tproj_id\tproj_short_name",
  "%R\t1001\tNorthgate Phase 2",
  "%T\tPROJWBS",
  "%F\twbs_id\twbs_short_name\twbs_name",
  "%R\t500\tSUB\tSubstructure",
  "%T\tTASK",
  "%F\ttask_id\ttask_code\ttask_name\twbs_id\ttarget_drtn_hr_cnt\tearly_start_date\tphys_complete_pct\tcstr_type\tcstr_date\tact_start_date\tact_end_date",
  "%R\t1\tA1000\tMobilise\t500\t40\t2026-01-05 08:00\t100\t\t\t2026-01-05 08:00\t2026-01-09 17:00",
  "%R\t2\tA1010\tPiling\t500\t160\t2026-01-12 08:00\t25\tCS_MSO\t2026-01-12 08:00\t\t",
  "%R\t3\tA1020\tPile caps\t500\t80\t2026-02-09 08:00\t0\t\t\t\t",
  "%T\tTASKPRED",
  "%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type\tlag_hr_cnt",
  "%R\t1\t2\t1\tPR_FS\t0",
  "%R\t2\t3\t2\tPR_FS\t24",
  "%R\t3\t3\t999\tPR_FS\t0",
  "%E",
].join("\n");

const MSP = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Title>Riverside Works</Title>
  <Tasks>
    <Task><UID>0</UID><Name>Riverside Works</Name><Summary>1</Summary></Task>
    <Task>
      <UID>1</UID><Name>Setup</Name><WBS>1.1</WBS>
      <Duration>PT40H0M0S</Duration><Start>2026-03-02T08:00:00</Start>
      <PercentComplete>50</PercentComplete><Summary>0</Summary>
    </Task>
    <Task>
      <UID>2</UID><Name>Excavate</Name><WBS>1.2</WBS>
      <Duration>P10D</Duration><Start>2026-03-09T08:00:00</Start>
      <ConstraintType>4</ConstraintType><ConstraintDate>2026-03-09T08:00:00</ConstraintDate>
      <Summary>0</Summary>
      <PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>9600</LinkLag></PredecessorLink>
      <PredecessorLink><PredecessorUID>77</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag></PredecessorLink>
    </Task>
    <Task><UID>3</UID><Name>Phase summary</Name><Summary>1</Summary></Task>
  </Tasks>
</Project>`;

describe("normaliseDate", () => {
  it("reads ISO, P6 date-time and DD-MMM-YY", () => {
    expect(normaliseDate("2026-01-05 08:00")).toBe("2026-01-05");
    expect(normaliseDate("2026-01-05T08:00:00")).toBe("2026-01-05");
    expect(normaliseDate("05-MAR-24")).toBe("2024-03-05");
    expect(normaliseDate("5-mar-2024")).toBe("2024-03-05");
  });

  it("returns null rather than a wrong date for what it cannot read", () => {
    expect(normaliseDate("")).toBeNull();
    expect(normaliseDate(null)).toBeNull();
    expect(normaliseDate("   ")).toBeNull();
    expect(normaliseDate("not a date")).toBeNull();
    expect(normaliseDate("05-XXX-24")).toBeNull();
  });
});

describe("XER", () => {
  it("splits the record stream into its tables", () => {
    const tables = parseXerTables(XER);
    expect([...tables.keys()]).toEqual(["PROJECT", "PROJWBS", "TASK", "TASKPRED"]);
    expect(tables.get("TASK")!.rows).toHaveLength(3);
    expect(tables.get("TASK")!.fields[1]).toBe("task_code");
  });

  it("imports the activities with durations in days and the WBS short name", () => {
    const out = parseXer(XER);
    expect(out.format).toBe("p6_xer");
    expect(out.projectName).toBe("Northgate Phase 2");
    expect(out.tasks.map((t) => t.taskCode)).toEqual(["A1000", "A1010", "A1020"]);
    const piling = out.tasks.find((t) => t.taskCode === "A1010")!;
    // 160 hours at 8h/day
    expect(piling.durationDays).toBe(20);
    expect(piling.wbsCode).toBe("SUB");
    expect(piling.percentComplete).toBe(25);
    // CS_MSO is a mandatory start
    expect(piling.constraintType).toBe("must_start_on");
    expect(piling.constraintDate).toBe("2026-01-12");
  });

  it("imports the logic with type and lag, converted from hours to days", () => {
    const out = parseXer(XER);
    expect(out.tasks.find((t) => t.taskCode === "A1010")!.predecessors).toBe("A1000:FS");
    // 24 lag hours = 3 days
    expect(out.tasks.find((t) => t.taskCode === "A1020")!.predecessors).toBe("A1010:FS+3");
  });

  it("counts and discloses a relationship pointing outside the file", () => {
    const out = parseXer(XER);
    expect(out.danglingLinks).toBe(1);
    expect(out.caveats.join(" ")).toContain("1 relationship(s)");
  });

  it("always discloses that calendars were not imported", () => {
    expect(parseXer(XER).caveats[0]).toContain("Calendars were not imported");
  });

  it("drops a constraint it cannot represent rather than substituting one", () => {
    // CS_ALAP ("as late as possible") has no equivalent in the three
    // constraints this platform's CPM understands. Substituting the nearest
    // one would move the critical path in a way nobody could trace back to the
    // import, so it is dropped and disclosed.
    const withAlap = XER.replace("%R\t3\tA1020\tPile caps\t500\t80\t2026-02-09 08:00\t0\t\t\t\t",
      "%R\t3\tA1020\tPile caps\t500\t80\t2026-02-09 08:00\t0\tCS_ALAP\t2026-02-09 08:00\t\t");
    const out = parseXer(withAlap);
    expect(out.tasks.find((t) => t.taskCode === "A1020")!.constraintType).toBeNull();
    expect(out.caveats.join(" ")).toContain("CS_ALAP x1");
  });

  it("carries actual dates and the earliest date seen", () => {
    const out = parseXer(XER);
    expect(out.earliestDate).toBe("2026-01-05");
    const mobilise = out.tasks[0]!;
    expect(mobilise.actualStart).toBe("2026-01-05");
    expect(mobilise.actualFinish).toBe("2026-01-09");
  });

  it("returns an empty programme rather than throwing on an empty file", () => {
    const out = parseXer("ERMHDR\t19.12\n%E\n");
    expect(out.tasks).toEqual([]);
  });
});

describe("MSP XML", () => {
  it("reads ISO 8601 durations in both forms", () => {
    expect(parseMspDuration("P10D")).toBe(10);
    expect(parseMspDuration("PT40H0M0S")).toBe(5);
    expect(parseMspDuration(null)).toBe(1);
    expect(parseMspDuration("nonsense")).toBe(1);
  });

  it("imports leaf activities and skips summaries and the project row", () => {
    const out = parseMspXml(MSP);
    expect(out.projectName).toBe("Riverside Works");
    expect(out.tasks.map((t) => t.name)).toEqual(["Setup", "Excavate"]);
    expect(out.caveats.join(" ")).toContain("Summary tasks");
  });

  it("converts LinkLag from tenths of a minute into days", () => {
    const out = parseMspXml(MSP);
    // 9600 tenths of a minute = 16 hours = 2 days
    expect(out.tasks.find((t) => t.name === "Excavate")!.predecessors).toBe("1:FS+2");
  });

  it("drops a link to a task outside the file and says how many", () => {
    const out = parseMspXml(MSP);
    expect(out.danglingLinks).toBe(1);
    expect(out.caveats.join(" ")).toContain("1 predecessor link(s)");
  });

  it("carries WBS, percent complete and constraints", () => {
    const excavate = parseMspXml(MSP).tasks.find((t) => t.name === "Excavate")!;
    expect(excavate.wbsCode).toBe("1.2");
    expect(excavate.constraintType).toBeTruthy();
    expect(excavate.constraintDate).toBe("2026-03-09");
    expect(parseMspXml(MSP).tasks.find((t) => t.name === "Setup")!.percentComplete).toBe(50);
  });
});

describe("sniffProgramme", () => {
  it("recognises each format from its content", () => {
    expect(sniffProgramme(XER, "unknown.dat")).toBe("p6_xer");
    expect(sniffProgramme(MSP, "unknown.dat")).toBe("msp_xml");
  });

  it("falls back to the extension, and gives up honestly", () => {
    expect(sniffProgramme("some,csv\n1,2\n", "programme.xer")).toBe("p6_xer");
    expect(sniffProgramme("some,csv\n1,2\n", "programme.xml")).toBe("msp_xml");
    expect(sniffProgramme("some,csv\n1,2\n", "programme.csv")).toBeNull();
  });
});

describe("parseProgramme + topoOrder", () => {
  it("dispatches to the right parser", () => {
    expect(parseProgramme(XER, "p6_xer").format).toBe("p6_xer");
    expect(parseProgramme(MSP, "msp_xml").format).toBe("msp_xml");
  });

  it("orders tasks so a predecessor is imported before its successor", () => {
    const tasks = parseXer(XER).tasks;
    const shuffled = [tasks[2]!, tasks[0]!, tasks[1]!];
    const ordered = topoOrder(shuffled).map((t) => t.taskCode);
    expect(ordered.indexOf("A1000")).toBeLessThan(ordered.indexOf("A1010"));
    expect(ordered.indexOf("A1010")).toBeLessThan(ordered.indexOf("A1020"));
  });

  it("does not loop for ever on a cyclic programme", () => {
    const cyclic: ProgrammeTaskRow[] = [
      {
        taskCode: "A",
        name: "A",
        wbsCode: null,
        durationDays: 1,
        actualStart: null,
        actualFinish: null,
        percentComplete: null,
        constraintType: null,
        constraintDate: null,
        predecessors: "B:FS",
        externalId: "x:A",
      },
      {
        taskCode: "B",
        name: "B",
        wbsCode: null,
        durationDays: 1,
        actualStart: null,
        actualFinish: null,
        percentComplete: null,
        constraintType: null,
        constraintDate: null,
        predecessors: "A:FS",
        externalId: "x:B",
      },
    ];
    const ordered = topoOrder(cyclic);
    expect(ordered).toHaveLength(2);
  });
});
