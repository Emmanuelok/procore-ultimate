/**
 * COBie handover workbook and its validator (spec Domain L #630-631) — pure.
 *
 * The sheets are built from the records the platform actually holds: assets
 * become Component, locations become Floor/Space, asset categories and
 * manufacturer/model pairs become Type, users become Contact, warranties and
 * their documents become Document, and every attribute bag becomes Attribute.
 *
 * A sheet with no source of truth in the platform (Zone, Spare, Resource,
 * Job) is returned EMPTY WITH A REASON rather than fabricated, and the
 * completeness score reports which required COBie fields are missing on which
 * component. A handover pack that looks complete but is not is worse than one
 * that says what it is missing.
 */

export interface CobieAsset {
  id: string;
  tagCode: string;
  name: string;
  category: string | null;
  classificationSystem: string | null;
  classificationCode: string | null;
  parentId: string | null;
  locationId: string | null;
  manufacturer: string | null;
  modelNumber: string | null;
  serialNumber: string | null;
  installedAt: string | null;
  commissionedAt: string | null;
  warrantyStart: string | null;
  warrantyMonths: number | null;
  expectedLifeYears: number | null;
  criticality: string;
  status: string;
  attributes: Record<string, unknown>;
  createdAt: string;
  createdBy: string;
  creatorEmail: string | null;
  spaceName: string | null;
}

export interface CobieLocation {
  id: string;
  name: string;
  parentId: string | null;
  path: string;
}

export interface CobieContact {
  id: string;
  email: string;
  name: string;
}

export interface CobieWarrantyDoc {
  id: string;
  assetId: string;
  provider: string;
  description: string | null;
  startDate: string;
  endDate: string;
  documentFileId: string | null;
}

export interface CobieProject {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
}

export interface CobieSheet {
  name: string;
  columns: string[];
  rows: Array<Record<string, string>>;
  /** why the sheet is empty, when it is */
  reason?: string;
}

export interface CobieValidationIssue {
  sheet: string;
  row: number | null;
  column: string | null;
  severity: "error" | "warning";
  message: string;
}

export interface CobieCompleteness {
  /** 0..100 across the required Component fields */
  score: number;
  fieldCoverage: Array<{ field: string; populated: number; total: number; percent: number }>;
  missingByComponent: Array<{ tagCode: string; missing: string[] }>;
}

export interface CobieWorkbook {
  sheets: CobieSheet[];
  issues: CobieValidationIssue[];
  completeness: CobieCompleteness;
  generatedAt: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const COMPONENT_COLUMNS = [
  "Name",
  "CreatedBy",
  "CreatedOn",
  "TypeName",
  "Space",
  "Description",
  "SerialNumber",
  "InstallationDate",
  "WarrantyStartDate",
  "TagNumber",
  "AssetIdentifier",
] as const;

const TYPE_COLUMNS = [
  "Name",
  "CreatedBy",
  "CreatedOn",
  "Category",
  "Description",
  "AssetType",
  "Manufacturer",
  "ModelNumber",
  "WarrantyDurationParts",
  "ExpectedLife",
] as const;

/** Fields COBie requires on a Component for a usable handover. */
const REQUIRED_COMPONENT_FIELDS = [
  "Name",
  "TypeName",
  "Space",
  "SerialNumber",
  "InstallationDate",
  "TagNumber",
] as const;

function typeKeyOf(asset: CobieAsset): string {
  return (
    [asset.manufacturer, asset.modelNumber].filter(Boolean).join(" ") ||
    asset.category ||
    asset.classificationCode ||
    "(uncategorised)"
  );
}

function describe(asset: CobieAsset): string {
  const fromAttributes = asset.attributes["description"];
  if (typeof fromAttributes === "string" && fromAttributes.trim()) return fromAttributes;
  return [asset.manufacturer, asset.modelNumber].filter(Boolean).join(" ");
}

export function componentRow(asset: CobieAsset): Record<string, string> {
  return {
    Name: asset.name,
    CreatedBy: asset.creatorEmail ?? "",
    CreatedOn: asset.createdAt,
    TypeName: typeKeyOf(asset),
    Space: asset.spaceName ?? "",
    Description: describe(asset),
    SerialNumber: asset.serialNumber ?? "",
    InstallationDate: asset.installedAt ?? "",
    WarrantyStartDate: asset.warrantyStart ?? "",
    TagNumber: asset.tagCode,
    AssetIdentifier: asset.id,
  };
}

/** Build the workbook. `locations` supplies Floor/Space; `contacts` supplies Contact. */
export function buildCobieWorkbook(input: {
  project: CobieProject;
  assets: CobieAsset[];
  locations: CobieLocation[];
  contacts: CobieContact[];
  warranties: CobieWarrantyDoc[];
  generatedAt?: string;
}): CobieWorkbook {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const components = input.assets.map(componentRow);

  const typeMap = new Map<string, Record<string, string>>();
  for (const asset of input.assets) {
    const key = typeKeyOf(asset);
    if (typeMap.has(key)) continue;
    typeMap.set(key, {
      Name: key,
      CreatedBy: asset.creatorEmail ?? "",
      CreatedOn: asset.createdAt,
      Category: asset.classificationCode ?? asset.category ?? "",
      Description: describe(asset),
      AssetType: "Fixed",
      Manufacturer: asset.manufacturer ?? "",
      ModelNumber: asset.modelNumber ?? "",
      WarrantyDurationParts: asset.warrantyMonths === null ? "" : String(asset.warrantyMonths),
      ExpectedLife: asset.expectedLifeYears === null ? "" : String(asset.expectedLifeYears),
    });
  }

  const floors = input.locations.filter((l) => l.parentId === null);
  const spaces = input.locations.filter((l) => l.parentId !== null);
  const floorNameOf = (location: CobieLocation): string => {
    let cursor: CobieLocation | undefined = location;
    const byId = new Map(input.locations.map((l) => [l.id, l]));
    let hops = 0;
    while (cursor && cursor.parentId && hops < 16) {
      cursor = byId.get(cursor.parentId);
      hops += 1;
    }
    return cursor?.name ?? "";
  };

  const sheets: CobieSheet[] = [
    {
      name: "Facility",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "ProjectName", "SiteName", "City", "Country"],
      rows: [
        {
          Name: input.project.name,
          CreatedBy: input.contacts[0]?.email ?? "",
          CreatedOn: generatedAt,
          Category: "",
          ProjectName: input.project.name,
          SiteName: input.project.address ?? "",
          City: input.project.city ?? "",
          Country: input.project.country ?? "",
        },
      ],
    },
    {
      name: "Contact",
      columns: ["Email", "CreatedBy", "CreatedOn", "GivenName", "FamilyName"],
      rows: input.contacts.map((c) => {
        const [given, ...rest] = c.name.split(" ");
        return {
          Email: c.email,
          CreatedBy: c.email,
          CreatedOn: generatedAt,
          GivenName: given ?? c.name,
          FamilyName: rest.join(" "),
        };
      }),
    },
    {
      name: "Floor",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "Description"],
      rows: floors.map((f) => ({
        Name: f.name,
        CreatedBy: input.contacts[0]?.email ?? "",
        CreatedOn: generatedAt,
        Category: "Floor",
        Description: f.name,
      })),
      reason: floors.length === 0 ? "No top-level locations exist on this project" : undefined,
    },
    {
      name: "Space",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "FloorName", "Description"],
      rows: spaces.map((s) => ({
        Name: s.name,
        CreatedBy: input.contacts[0]?.email ?? "",
        CreatedOn: generatedAt,
        Category: "Space",
        FloorName: floorNameOf(s),
        Description: s.name,
      })),
      reason: spaces.length === 0 ? "No nested locations exist to act as spaces" : undefined,
    },
    {
      name: "Type",
      columns: [...TYPE_COLUMNS],
      rows: [...typeMap.values()].sort((a, b) => a["Name"]!.localeCompare(b["Name"]!)),
      reason: typeMap.size === 0 ? "No assets have been registered" : undefined,
    },
    {
      name: "Component",
      columns: [...COMPONENT_COLUMNS],
      rows: components,
      reason: components.length === 0 ? "No assets have been registered" : undefined,
    },
    {
      name: "Assembly",
      columns: ["Name", "CreatedBy", "CreatedOn", "SheetName", "ParentName", "ChildNames"],
      rows: input.assets
        .filter((a) => a.parentId !== null)
        .map((a) => {
          const parent = input.assets.find((p) => p.id === a.parentId);
          return {
            Name: `${parent?.tagCode ?? a.parentId}-${a.tagCode}`,
            CreatedBy: a.creatorEmail ?? "",
            CreatedOn: a.createdAt,
            SheetName: "Component",
            ParentName: parent?.name ?? "",
            ChildNames: a.name,
          };
        }),
      reason: input.assets.every((a) => a.parentId === null)
        ? "No asset has a parent, so there is no assembly structure to export"
        : undefined,
    },
    {
      name: "Document",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "SheetName", "RowName", "Directory", "File"],
      rows: input.warranties.map((w) => {
        const asset = input.assets.find((a) => a.id === w.assetId);
        return {
          Name: `Warranty - ${w.provider}`,
          CreatedBy: asset?.creatorEmail ?? "",
          CreatedOn: w.startDate,
          Category: "Warranty",
          SheetName: "Component",
          RowName: asset?.name ?? "",
          Directory: "",
          File: w.documentFileId ?? "",
        };
      }),
      reason: input.warranties.length === 0 ? "No warranties have been recorded" : undefined,
    },
    {
      name: "Attribute",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "SheetName", "RowName", "Value", "Unit"],
      rows: input.assets.flatMap((a) =>
        Object.entries(a.attributes)
          .filter(([, value]) => value !== null && value !== undefined && value !== "")
          .map(([key, value]) => ({
            Name: key,
            CreatedBy: a.creatorEmail ?? "",
            CreatedOn: a.createdAt,
            Category: "Asset",
            SheetName: "Component",
            RowName: a.name,
            Value: String(value),
            Unit: "",
          })),
      ),
    },
    {
      name: "Zone",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "SpaceNames"],
      rows: [],
      reason: "Zones are not modelled in the platform — add them to the location tree to export them",
    },
    {
      name: "Spare",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "TypeName", "Suppliers"],
      rows: [],
      reason: "No spare-parts register exists yet, so this sheet is empty rather than invented",
    },
    {
      name: "Job",
      columns: ["Name", "CreatedBy", "CreatedOn", "Category", "TypeName", "Duration", "Frequency"],
      rows: [],
      reason: "Planned-maintenance jobs are not modelled yet",
    },
  ];

  return {
    sheets,
    issues: validateCobie(sheets),
    completeness: scoreCompleteness(input.assets),
    generatedAt,
  };
}

/** Referential and format checks over the built sheets (#630). */
export function validateCobie(sheets: CobieSheet[]): CobieValidationIssue[] {
  const issues: CobieValidationIssue[] = [];
  const sheet = (name: string) => sheets.find((s) => s.name === name);
  const components = sheet("Component")?.rows ?? [];
  const types = sheet("Type")?.rows ?? [];
  const spaces = sheet("Space")?.rows ?? [];
  const contacts = sheet("Contact")?.rows ?? [];

  const spaceNames = new Set(spaces.map((r) => r["Name"]));
  const typeNames = new Set(types.map((r) => r["Name"]));
  const contactEmails = new Set(contacts.map((r) => r["Email"]));

  const seenNames = new Set<string>();
  components.forEach((row, index) => {
    const rowNumber = index + 2; // header is row 1
    if (!row["Name"]) {
      issues.push({ sheet: "Component", row: rowNumber, column: "Name", severity: "error", message: "Name is required" });
    } else if (seenNames.has(row["Name"])) {
      issues.push({
        sheet: "Component",
        row: rowNumber,
        column: "Name",
        severity: "error",
        message: `Duplicate component name "${row["Name"]}" — COBie names must be unique`,
      });
    } else {
      seenNames.add(row["Name"]);
    }
    if (row["Space"] && !spaceNames.has(row["Space"])) {
      issues.push({
        sheet: "Component",
        row: rowNumber,
        column: "Space",
        severity: "error",
        message: `Space "${row["Space"]}" does not exist on the Space sheet`,
      });
    }
    if (!row["Space"]) {
      issues.push({
        sheet: "Component",
        row: rowNumber,
        column: "Space",
        severity: "warning",
        message: "Component is not located in a space",
      });
    }
    if (row["TypeName"] && !typeNames.has(row["TypeName"])) {
      issues.push({
        sheet: "Component",
        row: rowNumber,
        column: "TypeName",
        severity: "error",
        message: `Type "${row["TypeName"]}" is missing from the Type sheet`,
      });
    }
    if (row["CreatedBy"] && !contactEmails.has(row["CreatedBy"])) {
      issues.push({
        sheet: "Component",
        row: rowNumber,
        column: "CreatedBy",
        severity: "warning",
        message: `CreatedBy "${row["CreatedBy"]}" is not on the Contact sheet`,
      });
    }
    for (const dateColumn of ["InstallationDate", "WarrantyStartDate"] as const) {
      const value = row[dateColumn];
      if (value && !ISO_DATE.test(value)) {
        issues.push({
          sheet: "Component",
          row: rowNumber,
          column: dateColumn,
          severity: "error",
          message: `${dateColumn} "${value}" is not an ISO date (YYYY-MM-DD)`,
        });
      }
    }
  });

  const seenTypes = new Set<string>();
  types.forEach((row, index) => {
    if (!row["Name"]) {
      issues.push({ sheet: "Type", row: index + 2, column: "Name", severity: "error", message: "Type name is required" });
      return;
    }
    if (seenTypes.has(row["Name"])) {
      issues.push({
        sheet: "Type",
        row: index + 2,
        column: "Name",
        severity: "error",
        message: `Duplicate type name "${row["Name"]}"`,
      });
    }
    seenTypes.add(row["Name"]);
  });

  if (components.length === 0) {
    issues.push({
      sheet: "Component",
      row: null,
      column: null,
      severity: "error",
      message: "A COBie deliverable with no components cannot be handed over",
    });
  }
  return issues;
}

/** Required-field coverage across components (#630 completeness score). */
export function scoreCompleteness(assets: CobieAsset[]): CobieCompleteness {
  if (assets.length === 0) {
    return {
      score: 0,
      fieldCoverage: REQUIRED_COMPONENT_FIELDS.map((field) => ({
        field,
        populated: 0,
        total: 0,
        percent: 0,
      })),
      missingByComponent: [],
    };
  }
  const rows = assets.map((a) => ({ asset: a, row: componentRow(a) }));
  const fieldCoverage = REQUIRED_COMPONENT_FIELDS.map((field) => {
    const populated = rows.filter(({ row }) => (row[field] ?? "").trim().length > 0).length;
    return {
      field,
      populated,
      total: rows.length,
      percent: Math.round((populated / rows.length) * 1000) / 10,
    };
  });
  const missingByComponent = rows
    .map(({ asset, row }) => ({
      tagCode: asset.tagCode,
      missing: REQUIRED_COMPONENT_FIELDS.filter((f) => (row[f] ?? "").trim().length === 0),
    }))
    .filter((r) => r.missing.length > 0);
  const totalCells = rows.length * REQUIRED_COMPONENT_FIELDS.length;
  const populatedCells = fieldCoverage.reduce((sum, f) => sum + f.populated, 0);
  return {
    score: Math.round((populatedCells / totalCells) * 1000) / 10,
    fieldCoverage,
    missingByComponent,
  };
}

/** Render one sheet as CSV text (cells escaped by the caller's csvCell). */
export function sheetToCsv(sheet: CobieSheet, cell: (value: unknown) => string): string {
  const lines = [sheet.columns.map(cell).join(",")];
  for (const row of sheet.rows) {
    lines.push(sheet.columns.map((c) => cell(row[c] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
