import type { FastifyPluginAsync } from "fastify";

/**
 * EQUIPMENT, PLANT & MATERIALS (M23) — tool key `equipment`.
 *
 * The plant register built around utilisation and idle time rather than
 * around a list of machines, maintenance schedules and records, inspection
 * certificates with the expiry that makes them matter, fuel and hours
 * readings, and a telematics table shaped to be pushed into through the
 * existing ingestion module (provider + device + timestamp uniqueness for
 * idempotent replay, `ingestionRunId` for provenance). Materials sit in the
 * same module: items, deliveries with per-line discrepancies, and stock
 * movements.
 *
 * Schema: packages/db/src/schema/equipment.ts —
 *   equipment, equipment_assignments, equipment_utilisation,
 *   equipment_maintenance_schedules, equipment_maintenance_records,
 *   equipment_certificates, equipment_readings,
 *   equipment_telematics_readings, material_items, material_deliveries,
 *   material_delivery_lines, material_stock_movements.
 *
 * Planned route surface, all under `/api/v1`:
 *   /companies/current/equipment           (+ /:id/assignments, /certificates,
 *                                             /maintenance, /readings)
 *   /projects/:projectId/equipment-utilisation
 *   /projects/:projectId/materials         (+ /deliveries, /stock-movements)
 *   /ingest/telematics                     (machine push, api_tokens scoped)
 *
 * Routes land in a follow-up; registering the empty plugin now fixes the
 * mount point and the tool key so nothing has to be renamed later.
 */
export const equipmentModule: FastifyPluginAsync = async () => {
  // Routes to follow.
};
