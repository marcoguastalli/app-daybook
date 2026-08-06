import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();

test.describe("container hardening (spec: security section)", () => {
  test("app runs as a non-root user", () => {
    expect(sh("docker exec daybook-app whoami")).toBe("bun");
  });

  test("app filesystem is read-only outside the data mount and tmpfs", () => {
    // no 2>&1: execSync puts stderr in the error message only when unredirected
    expect(() => sh("docker exec daybook-app touch /app/x")).toThrow(/Read-only/);
    // the two writable exceptions
    sh("docker exec daybook-app sh -c 'touch /tmp/ok && rm /tmp/ok'");
    sh("docker exec daybook-app sh -c 'touch /data/topics/.probe && rm /data/topics/.probe'");
  });

  test("no-new-privileges is set on app and postgres", () => {
    for (const name of ["daybook-app", "daybook-postgres"]) {
      const opts = sh(`docker inspect --format '{{json .HostConfig.SecurityOpt}}' ${name}`);
      expect(opts).toContain("no-new-privileges:true");
    }
  });

  test("postgres exposes no host port", () => {
    const ports = sh("docker inspect --format '{{json .NetworkSettings.Ports}}' daybook-postgres");
    expect(ports).not.toContain("HostPort");
  });
});
