-- Custom migration (no schema change). 0011_platform_upgrade added
-- `currency text DEFAULT 'USD' NOT NULL` to valuations, variations and
-- payment_certificates. On a database that already held rows, every one of
-- them was stamped USD regardless of the contract it belongs to, and the cost
-- metrics (benchmarks, analytics) then refuse mixed-currency inputs — or,
-- worse, sum a GBP contract's variations as dollars. Restore each row's
-- currency from the record that actually declares it. Idempotent: each
-- statement only touches rows whose value disagrees with its source.
--
-- Order matters: valuations first (certificates copy from them), and for
-- variations the same precedence the API applies at creation — the linked
-- contract, else the project's first BoQ, else the project's own currency.

UPDATE "valuations" v
   SET "currency" = c."currency"
  FROM "contracts" c
 WHERE v."contract_id" = c."id"
   AND v."currency" <> c."currency";--> statement-breakpoint

UPDATE "variations" v
   SET "currency" = c."currency"
  FROM "contracts" c
 WHERE v."contract_id" = c."id"
   AND v."currency" <> c."currency";--> statement-breakpoint

UPDATE "variations" v
   SET "currency" = src."currency"
  FROM (
        SELECT DISTINCT ON (b."project_id") b."project_id", b."currency"
          FROM "boqs" b
         ORDER BY b."project_id", b."created_at" ASC
       ) src
 WHERE v."contract_id" IS NULL
   AND v."project_id" = src."project_id"
   AND v."currency" <> src."currency";--> statement-breakpoint

UPDATE "variations" v
   SET "currency" = p."currency"
  FROM "projects" p
 WHERE v."contract_id" IS NULL
   AND v."project_id" = p."id"
   AND NOT EXISTS (SELECT 1 FROM "boqs" b WHERE b."project_id" = v."project_id")
   AND v."currency" <> p."currency";--> statement-breakpoint

UPDATE "payment_certificates" pc
   SET "currency" = v."currency"
  FROM "valuations" v
 WHERE pc."valuation_id" = v."id"
   AND pc."currency" <> v."currency";
