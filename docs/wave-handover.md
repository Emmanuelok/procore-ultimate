# Upgrade wave — handover

What the wave did, how it was gated, and — the part worth reading — what it
deliberately did **not** build.

## How it was built

Thirty work packages with disjoint file ownership. Each was built by one
implementer, handed to an adversarial verifier told to break it, and then fixed
against those findings with a regression test per fix.

All twenty-nine domain packages came back `fix_required` on first review. That
is the pipeline working: 191 findings across the first fifteen alone, four of
them blockers, and none of them the kind of thing a test suite written by the
same author would have caught.

## The gate

Run at `ae7fa20`, working tree clean:

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm build` | 0 |
| `pnpm --filter @constructos/api --prod deploy` | 0 |
| API typecheck | 0 |
| Web typecheck | 0 |
| Web build | 0 |
| Migration regenerate | 0 |
| API test suite | 295 files, 7,721 tests, 0 failures |
| Production boot probe | loads and warns; does not refuse |

**Two caveats on the gate itself, stated rather than buried.**

The Docker *image* was not built — the build environment has the Docker client
but no daemon. The Dockerfile's build-stage commands were run verbatim instead,
which proves the build steps and not the image assembly.

The suite must be run serially. At the configured `maxWorkers=3` the
PGlite-booting files time out in `beforeAll` and report a false red;
`vitest.config.ts` now carries a 300s hook timeout so a starved runner is
distinguishable from a failing test. If the suite ever reports a `beforeAll`
timeout, re-run that file alone before believing it.

## Not built — declared, not hidden

Every package was asked to name what it did not do. The substantive ones:

**Standards and formats.** BCF import and `.bcfzip` export (the export is a
BCF-2.1-*shaped* JSON topic, labelled as such — there is no round trip from
Navisworks or Solibri). IDS 1.0 XML validation. P6 XER *export* — the route
returns 400 saying so; P6 imports MSPDI, which is exported. Meeting minutes are
print-ready HTML, not PDF bytes: there is no server-side PDF writer in the repo.

**Depth behind a working surface.** Clash detection is an AABB broad phase; the
narrow phase (triangle-triangle on tessellated geometry) is not built, and every
result says so. Lessons retrieval uses a deterministic ranker plus an in-process
tf-idf index rather than pgvector embeddings.

**Deliberate scope boundaries.** SAML 2.0 SP needs a reviewed XML-DSIG
dependency and was not added on this pass. The OCDS export and the time-boxed
regulator portal. SCIM 2.0 provisioning and company-to-company links. A
tool-using assistant with persistent conversations. Programme-level benefits
aggregation. The retainage-release application type sits on the FIN2 boundary
and is read-only from FIN1.

**Honest refusals worth keeping.** Sub-quote currency is never converted into
the estimate's currency, by design — an FX rate nobody recorded inside a tender
is a fiction, so the API returns the figures per currency and says why.
Bonding-line headroom is refused because no facility limit exists to divide by.
Cover requirements inferred from clause references report *unknown* rather than
"no gaps".

The full per-package list is in each package's own report.

## Two deployment facts

`main` currently holds a mid-write WIP checkpoint that does not compile. It is
this branch at `a9f2913`, merged while implementers were still writing files.
Deploying it will fail on TypeScript errors every time.

Production config **warns** rather than refusing on a reduced-shape deployment
(embedded database, local storage driver, localhost `APP_BASE_URL`, no email
transport, no anchor signing key, no model key). Refusals are limited to a
guessable signing secret and an explicitly chosen storage driver left
unconfigured. An earlier version threw on the warnings too, and that mistake
took a live deployment down: a configuration smell must never be a bigger outage
than the problem it warns about. The warnings are logged at boot and returned by
`GET /api/v1/health/ready`, which still answers 200 when only warnings are
present.
