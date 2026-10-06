import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { load as parseYaml } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { signingConfig, accessToken, jsignArgs, REQUIRED } = require("./sign-windows.cjs");

const SHELL_DIR = path.resolve(process.cwd(), "electron");
const jar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "armada-jsign-")), "jsign.jar");
fs.writeFileSync(jar, "");
afterAll(() => fs.rmSync(path.dirname(jar), { recursive: true, force: true }));

const FULL = {
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "s3cret",
  AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
  AZURE_SIGNING_ACCOUNT: "soapbox",
  AZURE_SIGNING_PROFILE: "armada",
  JSIGN_JAR: jar,
};

describe("Windows signing configuration", () => {
  it("leaves the build unsigned when nothing is configured", () => {
    expect(signingConfig({})).toBeNull();
  });

  it("refuses a partial configuration rather than shipping unsigned", () => {
    for (const name of REQUIRED) {
      const env = { ...FULL, [name]: "" };
      expect(() => signingConfig(env)).toThrow(name);
    }
  });

  it("requires the Jsign jar once configured", () => {
    expect(() => signingConfig({ ...FULL, JSIGN_JAR: "" })).toThrow("JSIGN_JAR");
    expect(() => signingConfig({ ...FULL, JSIGN_JAR: `${jar}.missing` })).toThrow("does not exist");
  });

  it("takes the endpoint as the portal shows it", () => {
    expect(signingConfig(FULL)).toEqual({
      jar,
      endpoint: "eus.codesigning.azure.net",
      alias: "soapbox/armada",
    });
  });
});

describe("Jsign invocation", () => {
  const config = signingConfig(FULL);
  const args = jsignArgs(config, {
    path: "/out/Armada-Setup.exe",
    hash: "sha256",
    name: "Armada",
    site: "https://armada.buzz",
  });

  it("signs through Artifact Signing with a Microsoft timestamp", () => {
    const value = (flag) => args[args.indexOf(flag) + 1];
    expect(value("--storetype")).toBe("TRUSTEDSIGNING");
    expect(value("--keystore")).toBe("eus.codesigning.azure.net");
    expect(value("--alias")).toBe("soapbox/armada");
    expect(value("--alg")).toBe("SHA-256");
    expect(value("--tsaurl")).toBe("http://timestamp.acs.microsoft.com");
    expect(value("--tsmode")).toBe("RFC3161");
    expect(args.at(-1)).toBe("/out/Armada-Setup.exe");
  });

  // The command line is visible to every process on the runner.
  it("names the token by environment variable and carries no credential", () => {
    expect(args[args.indexOf("--storepass") + 1]).toMatch(/^env:/);
    const joined = args.join(" ");
    for (const secret of ["s3cret", "tenant", "client"]) expect(joined).not.toContain(secret);
  });

  it("rejects a hash Jsign is not asked for", () => {
    expect(() => jsignArgs(config, { path: "x.exe", hash: "md5" })).toThrow("md5");
  });
});

describe("Azure access token", () => {
  it("exchanges client credentials for a codesigning token", async () => {
    let request;
    const fetchImpl = async (url, init) => {
      request = { url, body: Object.fromEntries(init.body) };
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    };
    await expect(accessToken(FULL, fetchImpl)).resolves.toBe("tok");
    expect(request.url).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
    expect(request.body).toEqual({
      grant_type: "client_credentials",
      client_id: "client",
      client_secret: "s3cret",
      scope: "https://codesigning.azure.net/.default",
    });
  });

  it("reports Entra's reason when the exchange fails", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret" }), {
        status: 401,
      });
    await expect(accessToken(FULL, fetchImpl)).rejects.toThrow("HTTP 401): AADSTS7000215");
  });
});

describe("electron-builder wiring", () => {
  const builder = parseYaml(fs.readFileSync(path.join(SHELL_DIR, "electron-builder.yml"), "utf8"));

  it("routes every Windows signature through the hook, once, in SHA-256", () => {
    expect(builder.win.signtoolOptions).toEqual({
      sign: "scripts/sign-windows.cjs",
      signingHashAlgorithms: ["sha256"],
    });
    expect(fs.existsSync(path.join(SHELL_DIR, builder.win.signtoolOptions.sign))).toBe(true);
  });
});
