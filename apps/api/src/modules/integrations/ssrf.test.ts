import { describe, expect, it } from "vitest";
import {
  checkWebhookUrl,
  checkWebhookUrlSync,
  classifyAddress,
  classifyIpv4,
  classifyIpv6,
  policyFor,
} from "./ssrf.js";

/**
 * Egress-guard unit tests.
 *
 * Every rule the guard enforces is a range or a name, so every one of them is
 * asserted here rather than trusted: the guard is the only thing standing
 * between a tenant admin's endpoint configuration and the platform's own
 * network, and a range that is silently missing looks exactly like a range that
 * is covered until somebody exploits it.
 */

const dev = { requireHttps: false, resolve: null };

describe("IPv4 classification", () => {
  it("refuses every private and special-purpose range", () => {
    const refused: [string, string][] = [
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.168.1.1", "private"],
      ["169.254.169.254", "link_local"],
      ["100.64.0.1", "carrier_grade_nat"],
      ["0.0.0.0", "unspecified"],
      ["224.0.0.1", "multicast"],
      ["255.255.255.255", "reserved"],
      ["198.18.0.1", "reserved"],
      ["192.0.0.1", "reserved"],
    ];
    for (const [address, code] of refused) {
      expect(classifyIpv4(address)?.code, address).toBe(code);
    }
  });

  it("allows ordinary public addresses, including near-miss neighbours", () => {
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "172.15.255.255", // one below the RFC1918 block
      "172.32.0.1", // one above it
      "169.253.0.1", // one below link-local
      "100.63.255.255", // one below CGNAT
      "223.255.255.255", // one below multicast
    ]) {
      expect(classifyIpv4(address), address).toBeNull();
    }
  });
});

describe("IPv6 classification", () => {
  it("refuses loopback, unspecified, link-local, unique-local and multicast", () => {
    expect(classifyIpv6("::1")?.code).toBe("loopback");
    expect(classifyIpv6("::")?.code).toBe("unspecified");
    expect(classifyIpv6("fe80::1")?.code).toBe("link_local");
    expect(classifyIpv6("fd00:ec2::254")?.code).toBe("unique_local");
    expect(classifyIpv6("fc00::1")?.code).toBe("unique_local");
    expect(classifyIpv6("ff02::1")?.code).toBe("multicast");
  });

  it("follows an IPv4-mapped address into the IPv4 rules — the classic bypass", () => {
    expect(classifyIpv6("::ffff:127.0.0.1")?.code).toBe("loopback");
    expect(classifyIpv6("::ffff:169.254.169.254")?.code).toBe("link_local");
    expect(classifyIpv6("::ffff:10.0.0.1")?.code).toBe("private");
    // a mapped PUBLIC address is still fine
    expect(classifyIpv6("::ffff:93.184.216.34")).toBeNull();
  });

  it("follows the NAT64 well-known prefix into the IPv4 rules", () => {
    expect(classifyIpv6("64:ff9b::7f00:1")?.code).toBe("loopback");
  });

  it("allows an ordinary global-unicast address", () => {
    expect(classifyIpv6("2606:4700:4700::1111")).toBeNull();
  });

  it("classifies bracketed and zone-suffixed forms", () => {
    expect(classifyAddress("[::1]")?.code).toBe("loopback");
    expect(classifyAddress("fe80::1%eth0")?.code).toBe("link_local");
  });
});

describe("URL checking", () => {
  it("refuses a non-http scheme and an unparseable string", () => {
    expect(checkWebhookUrlSync("file:///etc/passwd", dev)).toMatchObject({ code: "scheme" });
    expect(checkWebhookUrlSync("not a url", dev)).toMatchObject({ code: "unparseable" });
  });

  it("refuses embedded credentials", () => {
    expect(checkWebhookUrlSync("https://user:pass@receiver.example/h", dev)).toMatchObject({
      code: "credentials",
    });
  });

  it("refuses the cloud metadata address and localhost by name", () => {
    expect(
      checkWebhookUrlSync("http://169.254.169.254/latest/meta-data/iam/", dev),
    ).toMatchObject({ code: "link_local" });
    expect(checkWebhookUrlSync("http://localhost:5432/", dev)).toMatchObject({
      code: "hostname",
    });
    expect(checkWebhookUrlSync("http://metadata.google.internal/", dev)).toMatchObject({
      code: "hostname",
    });
    expect(checkWebhookUrlSync("http://db.internal/hook", dev)).toMatchObject({
      code: "hostname",
    });
  });

  it("refuses a private literal even on https", () => {
    expect(checkWebhookUrlSync("https://10.0.0.5:5432/", dev)).toMatchObject({ code: "private" });
  });

  it("insists on https only where the policy says so", () => {
    expect(checkWebhookUrlSync("http://receiver.example/h", dev).ok).toBe(true);
    expect(
      checkWebhookUrlSync("http://receiver.example/h", { requireHttps: true }),
    ).toMatchObject({ code: "https_required" });
    expect(checkWebhookUrlSync("https://receiver.example/h", { requireHttps: true }).ok).toBe(
      true,
    );
  });

  it("honours an explicit operator allowlist and nothing beyond it", () => {
    const policy = { requireHttps: false, allowHosts: ["receiver.internal"] };
    expect(checkWebhookUrlSync("http://receiver.internal/h", policy).ok).toBe(true);
    expect(checkWebhookUrlSync("http://other.internal/h", policy)).toMatchObject({
      code: "hostname",
    });
  });
});

describe("DNS resolution", () => {
  it("refuses a public NAME that resolves privately — the rebinding case", async () => {
    const verdict = await checkWebhookUrl("https://sneaky.example/hook", {
      requireHttps: false,
      resolve: async () => ["127.0.0.1"],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("loopback");
      expect(verdict.reason).toContain("sneaky.example");
      expect(verdict.reason).toContain("127.0.0.1");
    }
  });

  it("refuses when ANY answer is private — a mixed answer is not a pass", async () => {
    const verdict = await checkWebhookUrl("https://mixed.example/hook", {
      requireHttps: false,
      resolve: async () => ["93.184.216.34", "10.1.2.3"],
    });
    expect(verdict.ok).toBe(false);
  });

  it("accepts a name whose every answer is public, and records the addresses", async () => {
    const verdict = await checkWebhookUrl("https://receiver.example/hook", {
      requireHttps: false,
      resolve: async () => ["93.184.216.34", "2606:4700::1111"],
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.addresses).toEqual(["93.184.216.34", "2606:4700::1111"]);
  });

  it("refuses a name that cannot be resolved, and one that resolves to nothing", async () => {
    await expect(
      checkWebhookUrl("https://gone.example/hook", {
        requireHttps: false,
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).resolves.toMatchObject({ code: "resolution_failed" });
    await expect(
      checkWebhookUrl("https://empty.example/hook", {
        requireHttps: false,
        resolve: async () => [],
      }),
    ).resolves.toMatchObject({ code: "no_addresses" });
  });

  it("does not consult DNS for a literal address — there is nothing to resolve", async () => {
    let called = 0;
    const verdict = await checkWebhookUrl("https://93.184.216.34/hook", {
      requireHttps: false,
      resolve: async () => {
        called += 1;
        return ["10.0.0.1"];
      },
    });
    expect(called).toBe(0);
    expect(verdict.ok).toBe(true);
  });
});

describe("policyFor", () => {
  it("resolves and insists on https in production, and does neither elsewhere", () => {
    const prod = policyFor({ NODE_ENV: "production" });
    expect(prod.requireHttps).toBe(true);
    expect(prod.resolve).not.toBeNull();

    const test = policyFor({ NODE_ENV: "test" });
    expect(test.requireHttps).toBe(false);
    expect(test.resolve).toBeNull();
  });

  it("parses an operator allowlist", () => {
    const policy = policyFor({
      NODE_ENV: "development",
      WEBHOOK_ALLOW_HOSTS: "a.internal, b.internal ,",
    });
    expect(policy.allowHosts).toEqual(["a.internal", "b.internal"]);
  });
});
