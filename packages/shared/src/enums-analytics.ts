/**
 * Shared enums for the analytics area (platform upgrade wave).
 * Add new `as const` string unions and their types here; never edit
 * enums.ts from a parallel work package.
 */

/**
 * Column sensitivity classes (#751). Every analytics column is classified, and
 * the class decides who may see it:
 *
 *  - `public`     — operational metadata: statuses, dates, counts, references.
 *  - `commercial` — money and terms: rates, claimed amounts, agreed values.
 *    Visible to a caller holding at least `standard` on the dataset's tool.
 *  - `pii`        — a person: names, nationalities, contact details, pay.
 *    Visible only to a caller holding at least `standard` on the dataset's
 *    tool, and never through a company-wide run by a project member.
 *
 * A column the caller may not see is REMOVED from the result and named in
 * `hiddenColumns` — a report never silently returns a blank column, because a
 * blank column reads as "no data" rather than "not yours".
 */
export const COLUMN_SENSITIVITIES = ["public", "commercial", "pii"] as const;
export type ColumnSensitivity = (typeof COLUMN_SENSITIVITIES)[number];

/** How a report execution was triggered. */
export const REPORT_RUN_TRIGGERS = ["manual", "scheduled", "dashboard"] as const;
export type ReportRunTrigger = (typeof REPORT_RUN_TRIGGERS)[number];

/** What a scheduled delivery renders and attaches. */
export const REPORT_FORMATS = ["csv", "json"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** Predictive insight kinds (#753-758). */
export const FORECAST_KINDS = ["cost_overrun", "schedule_overrun"] as const;
export type ForecastKind = (typeof FORECAST_KINDS)[number];

/**
 * Reference-class size band (#833-838). A distribution is a comparison only if
 * its members are comparable, so a contributed sample declares the size band it
 * belongs to and the class publishes it. The other class dimension —
 * procurement route — reuses PROCUREMENT_ROUTES from enums.ts, which is the
 * vocabulary contracts.procurementRoute is already written in.
 */
export const SIZE_BANDS = ["under_5m", "5m_25m", "25m_100m", "100m_500m", "over_500m"] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];
