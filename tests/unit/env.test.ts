import { describe, expect, it } from "vitest";
import { assertNoPublicSecrets, parseEnv, webEnvSchema, workerEnvSchema } from "@/env";

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://control_plane:x@postgres:5432/control_plane",
  AUTH_SECRET: "a".repeat(48),
  AUTH_URL: "https://cp.bimacreative.tech",
  AUTH_KEYCLOAK_ID: "control-plane",
  AUTH_KEYCLOAK_SECRET: "s".repeat(32),
  AUTH_KEYCLOAK_ISSUER: "https://auth.bimacreative.tech/realms/platform",
};

describe("env (Zod)", () => {
  it("menerima env web yang valid dan mengisi default", () => {
    const env = parseEnv(webEnvSchema, valid);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.AUTH_KEYCLOAK_ID).toBe("control-plane");
  });

  it("menolak AUTH_SECRET pendek tanpa membocorkan nilainya", () => {
    const secret = "short-secret-value";
    let message = "";
    try {
      parseEnv(webEnvSchema, { ...valid, AUTH_SECRET: secret });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("AUTH_SECRET");
    expect(message).not.toContain(secret);
  });

  it("menolak DATABASE_URL non-postgres dan variabel wajib yang hilang", () => {
    expect(() => parseEnv(webEnvSchema, { ...valid, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
    const missing: Record<string, string | undefined> = { ...valid, AUTH_KEYCLOAK_SECRET: undefined };
    expect(() => parseEnv(webEnvSchema, missing)).toThrow(/AUTH_KEYCLOAK_SECRET/);
  });

  it("mewajibkan https di production dan issuer berbentuk /realms/<realm>", () => {
    expect(() => parseEnv(webEnvSchema, { ...valid, AUTH_URL: "http://cp.bimacreative.tech" })).toThrow(/AUTH_URL/);
    expect(() =>
      parseEnv(webEnvSchema, { ...valid, AUTH_KEYCLOAK_ISSUER: "https://auth.bimacreative.tech/" }),
    ).toThrow(/AUTH_KEYCLOAK_ISSUER/);
    expect(parseEnv(webEnvSchema, { ...valid, NODE_ENV: "development", AUTH_URL: "http://localhost:3000" }).AUTH_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("env worker hanya butuh DATABASE_URL", () => {
    expect(parseEnv(workerEnvSchema, { DATABASE_URL: valid.DATABASE_URL }).NODE_ENV).toBe("production");
  });

  it("menolak NEXT_PUBLIC_* yang terlihat seperti secret", () => {
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_AUTH_SECRET: "x" })).toThrow(/NEXT_PUBLIC_AUTH_SECRET/);
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_API_KEY: "x" })).toThrow();
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_APP_NAME: "cp" })).not.toThrow();
  });
});
