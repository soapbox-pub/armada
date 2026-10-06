"use strict";

// electron-builder's custom Windows signing hook (`win.signtoolOptions.sign`),
// called once per executable it produces: Armada.exe, the NSIS uninstaller, the
// installer and the portable exe. Signs with Azure Artifact Signing (formerly
// Trusted Signing) through Jsign, because the release runner is Linux and
// neither signtool nor Microsoft's signing client runs there.
//
// Configured entirely by environment, so one build config serves a signed
// release, an unsigned fork, and a local `npm run dist:win`:
//
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
//                           the app registration holding the "Artifact Signing
//                           Certificate Profile Signer" role. Exchanged here for
//                           an access token, which reaches Jsign through its
//                           environment rather than its command line.
//   AZURE_SIGNING_ENDPOINT  the account's regional endpoint, e.g.
//                           https://eus.codesigning.azure.net
//   AZURE_SIGNING_ACCOUNT   the Artifact Signing account name
//   AZURE_SIGNING_PROFILE   the certificate profile name
//   JSIGN_JAR               path to the Jsign all-in-one jar
//
// None set: the build is unsigned. Some set: the build FAILS, so a
// half-provisioned setup cannot quietly ship unsigned installers.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const CREDENTIALS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const SETTINGS = ["AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE"];
const REQUIRED = [...CREDENTIALS, ...SETTINGS];

// Microsoft's timestamp authority, the one Artifact Signing documents. The
// service issues certificates valid for three days, so a signature without a
// timestamp would stop verifying three days after the release.
const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";

const HASH_ALGORITHMS = { sha1: "SHA-1", sha256: "SHA-256" };

const TOKEN_ENV = "ARMADA_SIGNING_TOKEN";

/** The signing configuration from `env`, or null when signing is not configured at all. */
function signingConfig(env = process.env) {
  const present = REQUIRED.filter((name) => env[name]);
  if (present.length === 0) return null;
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Windows signing is partially configured: ${missing.join(", ")} unset ` +
        `(${present.join(", ")} set). Set all of ${REQUIRED.join(", ")} or none.`,
    );
  }
  if (!env.JSIGN_JAR || !fs.existsSync(env.JSIGN_JAR)) {
    throw new Error(`Windows signing is configured but JSIGN_JAR (${env.JSIGN_JAR || "unset"}) does not exist`);
  }
  return {
    jar: env.JSIGN_JAR,
    // Jsign wants the bare host; the portal shows the endpoint as a URL.
    endpoint: env.AZURE_SIGNING_ENDPOINT.replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    alias: `${env.AZURE_SIGNING_ACCOUNT}/${env.AZURE_SIGNING_PROFILE}`,
  };
}

/**
 * An Entra ID access token for the signing service, by client credentials.
 * Jsign 7.5 takes only a token for TRUSTEDSIGNING, not the credentials.
 */
async function accessToken(env = process.env, fetchImpl = fetch) {
  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(env.AZURE_TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.AZURE_CLIENT_ID,
        client_secret: env.AZURE_CLIENT_SECRET,
        scope: "https://codesigning.azure.net/.default",
      }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    // Entra's error_description names the cause (bad secret, unknown tenant)
    // and never echoes the secret.
    throw new Error(
      `Azure token request failed (HTTP ${response.status}): ${body.error_description || body.error || "no token"}`,
    );
  }
  return body.access_token;
}

/** Jsign's arguments for signing `file`. The token is read from TOKEN_ENV, never passed here. */
function jsignArgs(config, { path: file, hash = "sha256", name, site }) {
  const alg = HASH_ALGORITHMS[hash];
  if (!alg) throw new Error(`unsupported signing hash ${hash}`);
  const args = [
    "-jar", config.jar,
    "--storetype", "TRUSTEDSIGNING",
    "--keystore", config.endpoint,
    "--storepass", `env:${TOKEN_ENV}`,
    "--alias", config.alias,
    "--alg", alg,
    "--tsaurl", TIMESTAMP_URL,
    "--tsmode", "RFC3161",
  ];
  if (name) args.push("--name", name);
  if (site) args.push("--url", site);
  args.push(file);
  return args;
}

let reportedUnsigned = false;
// One token for the whole build: it lives an hour, and a build signs five files.
let token = null;

module.exports = async function sign(configuration) {
  const config = signingConfig();
  if (!config) {
    if (!reportedUnsigned) {
      console.log("  • Windows signing not configured (no AZURE_SIGNING_*); executables are unsigned");
      reportedUnsigned = true;
    }
    return;
  }
  token ??= accessToken();
  const env = { ...process.env, [TOKEN_ENV]: await token };
  console.log(`  • signing ${configuration.path} with Artifact Signing (${config.alias})`);
  execFileSync("java", jsignArgs(config, configuration), { stdio: "inherit", env });
};
module.exports.signingConfig = signingConfig;
module.exports.accessToken = accessToken;
module.exports.jsignArgs = jsignArgs;
module.exports.REQUIRED = REQUIRED;
