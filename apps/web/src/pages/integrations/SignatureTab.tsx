/**
 * The delivery contract, written for the person implementing the receiver.
 *
 * Everything a receiver needs is on this page: the headers, the exact
 * string-to-sign, working verification code, the dedupe rule, and the
 * retry/backoff behaviour with the consequence that follows from it — retries
 * re-send identical bytes under an identical signature, so a freshness window
 * has to cover the whole retry budget and replay protection has to come from
 * the delivery id.
 *
 * Where the live status endpoint is readable, the constants below are replaced
 * with the values actually in force and labelled as such. Where it is not, the
 * documented defaults are shown and labelled as documented rather than
 * observed — a receiver implementer should never have to guess which they are
 * looking at.
 */
import { Badge, Card, CardBody, Table, Td, Th } from "../../ui";
import {
  Caveat,
  CodeBlock,
  SharedCustodyNotice,
  msDuration,
  num,
  retryBudgetMs,
  type SigningContract,
  type WebhookStatusResponse,
} from "./integrationsShared";

/** The wire contract as signing.ts defines it — the fallback when status is unreadable. */
const DOCUMENTED: SigningContract = {
  algorithm: "HMAC-SHA256",
  signatureVersion: "v1",
  headers: {
    signature: "x-constructos-signature",
    timestamp: "x-constructos-timestamp",
    delivery: "x-constructos-delivery",
    event: "x-constructos-event",
    endpoint: "x-constructos-endpoint",
    company: "x-constructos-company",
    attempt: "x-constructos-attempt",
  },
  stringToSign: "v1:{timestamp}:{deliveryId}:{rawBody}",
  signatureHeaderFormat: "v1=<lowercase hex hmac-sha256>",
  verify:
    "Recompute the HMAC over the RAW body before parsing it, join with literal colons, and " +
    "compare in constant time. Dedupe on the delivery header: a retry re-sends identical bytes " +
    "and an identical signature, so a freshness window must cover the whole retry budget rather " +
    "than a few seconds.",
  keySource: { source: "unknown", sharedCustody: false, note: "" },
};

const HEADER_NOTES: { key: keyof SigningContract["headers"]; signed: boolean; note: string }[] = [
  {
    key: "event",
    signed: true,
    note: 'The event kind, "objectType.action" — or "ping" for a synthetic test delivery. Signed only in the sense that it also appears inside the body; the header itself is not part of the string-to-sign.',
  },
  {
    key: "delivery",
    signed: true,
    note: "The delivery id. THIS IS THE DEDUPE KEY. It is bound into the string-to-sign, so a body captured from one delivery cannot be replayed as another, and it is stable across every retry attempt.",
  },
  {
    key: "endpoint",
    signed: false,
    note: "The endpoint id this delivery was addressed to. Useful when one receiver serves several endpoints; it also appears in the body.",
  },
  {
    key: "company",
    signed: false,
    note: "The tenant the event belongs to. A receiver serving several tenants should route on this and verify with that tenant's secret.",
  },
  {
    key: "timestamp",
    signed: true,
    note: "Unix SECONDS, fixed at enqueue — not per attempt. Part of the string-to-sign. It does not advance on a retry, so a retry that arrives an hour later still carries the original value.",
  },
  {
    key: "attempt",
    signed: false,
    note: "1-based attempt counter. NOT SIGNED and NOT part of the string-to-sign — it is the one header that changes between otherwise identical retries, which is precisely why it is excluded.",
  },
  {
    key: "signature",
    signed: false,
    note: "The signature itself: v1=<lowercase hex hmac-sha256>.",
  },
];

export default function SignatureTab({ status }: { status: WebhookStatusResponse | null }) {
  const signing = status?.signing ?? DOCUMENTED;
  const live = status !== null;
  const tuning = status?.delivery ?? null;
  const budget = tuning ? retryBudgetMs(tuning) : null;

  const maxAttempts = tuning?.maxAttempts ?? 6;
  const backoffBase = tuning?.backoffBaseMs ?? 2000;
  const backoffMax = tuning?.backoffMaxMs ?? 300_000;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-ink-500">
          Everything needed to build a receiver, without leaving this page. Values are{" "}
          {live ? (
            <Badge tone="green">live — read from this deployment</Badge>
          ) : (
            <Badge tone="amber">documented defaults — the status endpoint was not readable</Badge>
          )}
          .
        </p>
      </div>

      {live ? <SharedCustodyNotice keySource={signing.keySource} /> : null}

      {/* ------------------------------- headers -------------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Request headers</h3>
          <p className="mb-3 text-xs text-ink-500">
            Every delivery is an HTTP POST with{" "}
            <code className="font-mono">content-type: application/json</code> and{" "}
            <code className="font-mono">user-agent: ConstructOS-Webhooks/1</code>, plus:
          </p>
          <Table>
            <thead className="bg-ink-50">
              <tr>
                <Th>Header</Th>
                <Th>In the string-to-sign</Th>
                <Th>Meaning</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {HEADER_NOTES.map((h) => (
                <tr key={h.key} className="align-top">
                  <Td>
                    <span className="font-mono text-xs text-ink-800">{signing.headers[h.key]}</span>
                  </Td>
                  <Td>
                    {h.key === "timestamp" || h.key === "delivery" ? (
                      <Badge tone="blue">yes</Badge>
                    ) : (
                      <Badge tone="gray">no</Badge>
                    )}
                  </Td>
                  <Td className="max-w-xl text-xs leading-relaxed text-ink-600">{h.note}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>

      {/* --------------------------- the string to sign -------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">String-to-sign</h3>
          <p className="mb-2 text-xs leading-relaxed text-ink-500">
            Four parts joined with <strong>literal colons</strong>, HMAC-SHA256 under the endpoint's
            secret, lower-case hex, prefixed <code className="font-mono">v1=</code> in the header.
          </p>
          <CodeBlock>{signing.stringToSign}</CodeBlock>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Definition term="v1" text={`Literal version prefix (${signing.signatureVersion}). Not the header value — the string itself starts with it.`} />
            <Definition
              term="{timestamp}"
              text={`The decimal value of ${signing.headers.timestamp}, unix seconds. Fixed at enqueue.`}
            />
            <Definition
              term="{deliveryId}"
              text={`The value of ${signing.headers.delivery}. Binding it in is what stops one delivery's body being replayed as another.`}
            />
            <Definition
              term="{rawBody}"
              text="The exact request bytes, before any parsing. The body is canonical JSON with sorted keys, so it is byte-stable — but do not re-serialise it to verify; a re-serialised object will not match."
            />
          </div>
          <div className="mt-3">
            <Caveat tone="amber">
              <span className="font-semibold">Verify before you parse.</span> Read the raw body,
              compute the HMAC over those bytes, compare in constant time, and only then decode the
              JSON. Any framework middleware that parses and re-serialises the body silently breaks
              verification — this is the single most common way a receiver integration fails.
            </Caveat>
          </div>
          <div className="mt-3 rounded-md bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-700">
            <span className="font-semibold">The API's own words on verification:</span>{" "}
            {signing.verify}
          </div>
        </CardBody>
      </Card>

      {/* ------------------------------- envelope -------------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Payload envelope</h3>
          <p className="mb-2 text-xs text-ink-500">
            Every delivery — real or ping — has the same shape. Only{" "}
            <code className="font-mono">data</code> varies.
          </p>
          <CodeBlock>{`{
  "id": "whd_…",                     // the delivery id; equals the delivery header
  "type": "rfi.create",              // event kind, or "ping" for a test delivery
  "companyId": "cmp_…",
  "projectId": "prj_…" | null,
  "occurredAt": "2026-08-25T09:14:02.117Z",
  "endpointId": "whe_…",
  "data": {
    "action": "create",              // one of: create, update, delete, state_change, access
    "objectType": "rfi",
    "objectId": "rfi_…",
    "actorId": "usr_…" | null,       // null when no human authored the change
    "ledgerSeq": 4711,
    "payloadHash": "<sha256 hex>",
    "entryHash": "<sha256 hex>"
  }
}`}</CodeBlock>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-400">
            The envelope carries identifiers and hashes, not record contents. A receiver that needs
            the record itself reads it back through the API with its own credentials — which is what
            keeps the webhook from becoming an unauthenticated export channel.{" "}
            <code className="font-mono">occurredAt</code> is the source of the signed timestamp:
            floor(Date.parse(occurredAt) / 1000). That means a delivery can be re-verified from the
            stored row alone, years later.
          </p>
        </CardBody>
      </Card>

      {/* ----------------------------- verification ------------------------------ */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Verification — Node.js</h3>
          <CodeBlock>{`import { createHmac, timingSafeEqual } from "node:crypto";

// express: app.post(path, express.raw({ type: "application/json" }), handler)
export function handler(req, res) {
  const raw = req.body;                                   // a Buffer — NOT a parsed object
  const ts  = req.get("${signing.headers.timestamp}");
  const id  = req.get("${signing.headers.delivery}");
  const sig = req.get("${signing.headers.signature}");

  const expected =
    "v1=" +
    createHmac("sha256", process.env.CONSTRUCTOS_WEBHOOK_SECRET)   // whsec_…
      .update(\`v1:\${ts}:\${id}:\${raw.toString("utf8")}\`)
      .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig ?? "", "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).end();

  // Freshness: cover the WHOLE retry budget, not a few seconds. See below.
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(ageSeconds) || ageSeconds > ${Math.ceil((budget ?? 3_600_000) / 1000)}) {
    return res.status(401).end();
  }

  // Dedupe: a retry is byte-identical, including the signature.
  if (alreadyProcessed(id)) return res.status(200).end();   // idempotent success
  markProcessed(id);

  const event = JSON.parse(raw.toString("utf8"));
  process(event);
  return res.status(200).end();                             // any 2xx = delivered
}`}</CodeBlock>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Verification — Python</h3>
          <CodeBlock>{`import hmac, hashlib, time

def verify(raw: bytes, headers, secret: str) -> bool:
    ts  = headers["${signing.headers.timestamp}"]
    did = headers["${signing.headers.delivery}"]
    sig = headers["${signing.headers.signature}"]

    to_sign = b"v1:" + ts.encode() + b":" + did.encode() + b":" + raw
    expected = "v1=" + hmac.new(secret.encode(), to_sign, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, sig):        # constant time
        return False
    # freshness window must span the retry budget (≈ ${budget ? msDuration(budget) : "1 h"})
    return (time.time() - int(ts)) <= ${Math.ceil((budget ?? 3_600_000) / 1000)}`}</CodeBlock>
        </CardBody>
      </Card>

      {/* --------------------------- retries and dedupe -------------------------- */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Retries, backoff and dedupe</h3>
          <div className="space-y-3 text-xs leading-relaxed text-ink-600">
            <p>
              A delivery succeeds on any <strong>2xx</strong>. Anything else — a 4xx, a 5xx, a
              connection error, a timeout after {tuning ? msDuration(tuning.requestTimeoutMs) : "10 s"}{" "}
              — is a failure and is retried. Redirects are <em>not</em> followed: a 3xx is a failure.
            </p>
            <div className="rounded-md bg-ink-50 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                Schedule {live ? "in force in this deployment" : "(documented defaults)"}
              </div>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Up to <strong>{num(maxAttempts)}</strong> attempts per delivery, then the delivery
                  is marked <code className="font-mono">exhausted</code> and abandoned.
                </li>
                <li>
                  Backoff is <code className="font-mono">base × 2^(attempt−1)</code>, from{" "}
                  {msDuration(backoffBase)} up to a ceiling of {msDuration(backoffMax)}, plus up to
                  20% jitter derived deterministically from the delivery id (so a thousand
                  simultaneous failures do not retry in lockstep).
                </li>
                <li>
                  Worst case from first attempt to exhaustion:{" "}
                  <strong>≈ {budget ? msDuration(budget) : "under an hour"}</strong>.
                </li>
                <li>
                  {tuning
                    ? `The queue drains on an in-process timer every ${msDuration(tuning.dispatchIntervalMs)} — "${tuning.mode}".`
                    : "The queue drains on an in-process interval timer; there is no external scheduler."}
                </li>
              </ul>
            </div>

            <Caveat tone="red">
              <span className="font-semibold">
                A retry re-sends identical bytes under an identical signature.
              </span>{" "}
              The signed timestamp is fixed at enqueue, not recomputed per attempt, and the stored
              signature is replayed verbatim. Two consequences you must design for:
              <ul className="mt-1 list-disc space-y-1 pl-5">
                <li>
                  <strong>Dedupe on <code className="font-mono">{signing.headers.delivery}</code>.</strong>{" "}
                  It is the only field that identifies "this event, this endpoint" across attempts.
                  Deduping on the payload hash or on <code className="font-mono">objectId</code>{" "}
                  will collapse genuinely distinct events; deduping on the attempt header will not
                  dedupe at all.
                </li>
                <li>
                  <strong>Do not enforce a tight freshness window.</strong> A short window (30 s,
                  5 min) rejects legitimate retries that were scheduled hours ago and looks exactly
                  like a signature failure from the outside. Size the window to at least{" "}
                  {budget ? msDuration(budget) : "the full retry budget"} and rely on delivery-id
                  dedupe — not on freshness — for replay protection.
                </li>
              </ul>
            </Caveat>

            <p>
              A manual retry from the delivery log re-arms the whole attempt budget from zero and
              sends the same bytes again. An already-delivered delivery cannot be retried at all —
              the API answers 409 rather than duplicate it at your end.
            </p>

            <Caveat tone="amber">
              <span className="font-semibold">Delivery is at-least-once, not exactly-once.</span>{" "}
              The dispatcher's de-duplication guard is per process. If this deployment runs more
              than one API replica, each drains the same queue and the same delivery id can arrive
              twice within seconds. Your dedupe is not belt-and-braces; it is load-bearing.
            </Caveat>

            <p>
              An endpoint auto-disables after{" "}
              <strong>{num(tuning?.failureThreshold ?? 5)}</strong> consecutive{" "}
              <em>exhausted</em> deliveries — a single failed attempt is noise, a delivery that
              burned its whole budget is evidence the receiver is gone. While an endpoint is
              disabled, matching events are <strong>not queued for it</strong> and re-enabling does
              not backfill them. A successful delivery resets the run to zero.
            </p>

            <p>
              Your response body is read and stored, truncated to{" "}
              {num(tuning?.responseBodyLimit ?? 2048)} characters, and shown in the delivery log.
              Put something diagnostic in it on a rejection — the operator on this end reads it.
            </p>
          </div>
        </CardBody>
      </Card>

      {/* ------------------------------ key custody ------------------------------ */}
      <Card>
        <CardBody>
          <h3 className="mb-1 text-sm font-semibold text-ink-900">Where the secret comes from</h3>
          <div className="space-y-2 text-xs leading-relaxed text-ink-600">
            <p>
              The secret is <strong>derived, not generated</strong>: HKDF-SHA256 over an
              environment-held master key, salted with the endpoint id, with info{" "}
              <code className="font-mono">constructos:webhook:v1</code>, rendered as{" "}
              <code className="font-mono">whsec_</code> + 64 hex characters. The database holds only
              its sha256, so a stolen database yields no usable signing key — and the platform can
              still sign, because it re-derives at send time.
            </p>
            <p>
              It follows that the secret is shown exactly once, in the endpoint-creation response,
              and no route will ever return it again. It also follows that{" "}
              <strong>rotating the master key invalidates every existing endpoint secret</strong>:
              the fingerprint stops matching, the endpoint's{" "}
              <code className="font-mono">secretFingerprintMatches</code> flag goes false, and the
              Webhooks tab raises it as an actionable warning. The remedy is to re-create the
              endpoint and install the new secret — there is no re-issue.
            </p>
          </div>
          {live ? (
            <div className="mt-3">
              <SharedCustodyNotice keySource={signing.keySource} />
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function Definition({ term, text }: { term: string; text: string }) {
  return (
    <div className="rounded-md bg-ink-50 px-3 py-2">
      <code className="font-mono text-xs font-semibold text-ink-800">{term}</code>
      <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">{text}</p>
    </div>
  );
}
