import { describe, expect, it } from "vitest";
import { parseClientListParams } from "@/lib/client-list-params";
import { buildCsp, generateNonce } from "@/lib/csp";

describe("parseClientListParams", () => {
  it("default aman", () => {
    expect(parseClientListParams({})).toEqual({ q: undefined, page: 1 });
  });
  it("menolak input berbahaya → diabaikan", () => {
    expect(parseClientListParams({ q: "%' OR 1=1 --", page: "-5" })).toEqual({ q: undefined, page: 1 });
    expect(parseClientListParams({ q: "acme", page: "3" })).toEqual({ q: "acme", page: 3 });
    expect(parseClientListParams({ q: ["acme", "x"], page: "99999" }).page).toBe(1);
  });
});

describe("CSP", () => {
  it("nonce acak dan tertanam di script-src; tanpa unsafe-inline/eval di production", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    const csp = buildCsp(a, false);
    expect(csp).toContain(`'nonce-${a}'`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });
});
