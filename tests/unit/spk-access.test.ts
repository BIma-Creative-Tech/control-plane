import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/datamart", () => ({ withMart: vi.fn(), datamartEnabled: () => true }));
import { aeOnly, type ClientAccess } from "@/server/spk-dashboard";

const base: ClientAccess = { client: "expomedia", login: "x", name: "X", canSeeValue: false, isProjectUser: false, isAe: false };

describe("lingkup baris per peran", () => {
  it("AE murni hanya SPK miliknya", () => {
    expect(aeOnly({ ...base, isAe: true })).toBe(true);
  });
  it("Owner/Finance & PM melihat semua SPK tenant", () => {
    expect(aeOnly({ ...base, isAe: true, canSeeValue: true })).toBe(false);
    expect(aeOnly({ ...base, isAe: true, isProjectUser: true })).toBe(false);
    expect(aeOnly({ ...base, isProjectUser: true })).toBe(false);
  });
});
