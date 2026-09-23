import { describe, expect, it } from "vitest";
import { isValidSlug, slugSchema } from "@/lib/slug";
import { handleNoop, parseNoopPayload } from "@/worker/jobs";

describe("whitelist slug ^[a-z0-9-]{3,30}$", () => {
  it.each(["abc", "acme", "client-01", "a".repeat(30)])("menerima %s", (s) => {
    expect(isValidSlug(s)).toBe(true);
    expect(slugSchema.safeParse(s).success).toBe(true);
  });

  it.each([
    "ab",
    "a".repeat(31),
    "Acme",
    "acme_prod",
    "acme;rm -rf /",
    "acme$(id)",
    "../etc",
    "acme\n",
    "acme ",
    "",
    "ácme",
  ])("menolak %j", (s) => {
    expect(isValidSlug(s)).toBe(false);
  });

  it("menolak non-string", () => {
    expect(isValidSlug(123)).toBe(false);
    expect(isValidSlug(null)).toBe(false);
  });
});

describe("job noop — argumen di-whitelist", () => {
  it("menerima payload valid", async () => {
    const p = parseNoopPayload({ slug: "acme" });
    await expect(handleNoop(p)).resolves.toEqual({ ok: true, slug: "acme" });
  });

  it("menolak slug invalid tanpa menggemakan input", () => {
    expect(() => parseNoopPayload({ slug: "x; rm -rf /" })).toThrow("argumen job noop ditolak whitelist");
    try {
      parseNoopPayload({ slug: "x; rm -rf /" });
    } catch (e) {
      expect((e as Error).message).not.toContain("rm -rf");
    }
  });

  it("menolak field tambahan (strict) dan id job non-uuid", () => {
    expect(() => parseNoopPayload({ slug: "acme", cmd: "id" })).toThrow();
    expect(() => parseNoopPayload({ slug: "acme", provisionJobId: "1 OR 1=1" })).toThrow();
    expect(() => parseNoopPayload(null)).toThrow();
  });
});
