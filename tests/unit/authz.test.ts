import { describe, expect, it } from "vitest";
import { decideAccess } from "@/lib/access";
import { can, extractRoles, PERMISSIONS, ROLES } from "@/lib/roles";

const CLIENT_ID = "control-plane";

describe("extractRoles (klaim ID token Keycloak)", () => {
  it("mengambil client role yang dikenal saja", () => {
    const claims = {
      sub: "u1",
      resource_access: { [CLIENT_ID]: { roles: ["ops", "superadmin", "uma_authorization", "ops"] } },
    };
    expect(extractRoles(claims, CLIENT_ID).sort()).toEqual(["ops", "superadmin"]);
  });

  it("mengabaikan role dari client lain dan realm_access", () => {
    const claims = {
      realm_access: { roles: ["superadmin"] },
      resource_access: { "other-client": { roles: ["superadmin"] } },
    };
    expect(extractRoles(claims, CLIENT_ID)).toEqual([]);
  });

  it.each([null, undefined, "x", {}, { resource_access: null }, { resource_access: { [CLIENT_ID]: { roles: "ops" } } }])(
    "klaim rusak %j → tanpa role",
    (claims) => {
      expect(extractRoles(claims, CLIENT_ID)).toEqual([]);
    },
  );
});

describe("otorisasi role (default deny)", () => {
  it("tanpa sesi → login", () => {
    expect(decideAccess(null, "dashboard:view")).toBe("login");
    expect(decideAccess(undefined, "clients:list")).toBe("login");
  });

  it("sesi tanpa role → forbidden", () => {
    expect(decideAccess({ roles: [] }, "dashboard:view")).toBe("forbidden");
    expect(decideAccess({}, "dashboard:view")).toBe("forbidden");
  });

  it("client_user/client_admin tidak boleh melihat daftar semua client", () => {
    expect(decideAccess({ roles: ["client_user"] }, "clients:list")).toBe("forbidden");
    expect(decideAccess({ roles: ["client_admin"] }, "clients:list")).toBe("forbidden");
    expect(decideAccess({ roles: ["client_admin"] }, "dashboard:view")).toBe("ok");
  });

  it("ops boleh list clients tapi tidak manage; superadmin boleh semua (kecuali izin bercakupan tenant sendiri)", () => {
    expect(can(["ops"], "clients:list")).toBe(true);
    expect(can(["ops"], "clients:manage")).toBe(false);
    // `users:manage_own` + izin portal = cakupan tenant SENDIRI (client_admin/client_user); superadmin memakai izin
    // platform (`users:manage`, semua tenant) dan tidak masuk portal.
    const TENANT_SCOPED = new Set(["users:manage_own", "portal:view", "portal:admin"]);
    for (const p of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can(["superadmin"], p)).toBe(!TENANT_SCOPED.has(p));
    }
  });

  it("setiap permission hanya berisi role yang valid", () => {
    for (const allowed of Object.values(PERMISSIONS)) {
      for (const r of allowed) expect(ROLES).toContain(r);
    }
  });
});
