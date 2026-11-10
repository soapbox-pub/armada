import fs from "node:fs";
import path from "node:path";

import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const builder = loadYaml(
  fs.readFileSync(path.resolve(root, "electron/electron-builder.yml"), "utf8"),
);
// The `desktop` job builds every installer AND stages it for the release event.
// There is no separate `publish` job any more: it existed only to sign and
// verify the Flatpak repository, and npkg (pkg.soapbox.pub) re-signs on import,
// so nothing here signs anything. Nothing is published over SSH — every
// artifact is named by the release event and fetched from Blossom by hash.
const workflowSource = fs.readFileSync(
  path.resolve(root, ".ngit/act/workflows/release.yml"),
  "utf8",
);
const workflow = loadYaml(workflowSource);
const desktopSteps = workflow.jobs.desktop.steps;
const namedStep = (name) => desktopSteps.find((step) => step.name === name);
const stepIndex = (name) => desktopSteps.indexOf(namedStep(name));

describe("desktop update publication", () => {
  // Kept only so app-update.yml is packaged; the url is never fetched.
  // publishAutoUpdate: false stops latest*.yml being generated.
  it("embeds a publish config in Electron packages but generates no feed", () => {
    expect(builder.publish).toEqual({
      provider: "generic",
      publishAutoUpdate: false,
      url: "https://armada.buzz/downloads/desktop",
    });
  });

  // The distribution channel is npkg (pkg.soapbox.pub): it hash-verifies each
  // artifact against the signed release event and re-signs the repositories with
  // its own keys. So the release ships an UNSIGNED Flatpak bundle — no release
  // GPG key, no sign.sh, no fingerprint announcement, no OSTree publish.
  it("carries no Flatpak signing apparatus", () => {
    expect(workflowSource).not.toContain("FLATPAK_GPG");
    expect(workflowSource).not.toContain("sign.sh");
    expect(workflowSource).not.toContain("armada-flatpak.fingerprint");
    expect(workflowSource).not.toContain("build-sign");
    expect(workflowSource).not.toContain("secrets.DEPLOY_SSH");
    expect(workflowSource).not.toContain("rsync");
    expect(fs.existsSync(path.resolve(root, "electron/flatpak/sign.sh"))).toBe(
      false,
    );

    // The bundle is built with no signing env at all.
    const flatpakBuild = namedStep("Build Flatpak bundle");
    expect(flatpakBuild).toBeDefined();
    expect(flatpakBuild.env).toBeUndefined();
    expect(flatpakBuild.run).toContain("npm run dist:flatpak");
  });

  it("builds every desktop installer in one job, in dependency order", () => {
    const order = [
      "Build standalone web bundle",
      "Build Linux + Windows installers",
      "Build Flatpak bundle",
      "Cross-build macOS app bundles",
      "Sign and zip the macOS bundles",
      "Stage installers for the release event",
    ];
    for (const name of order) expect(stepIndex(name)).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) {
      expect(stepIndex(order[i])).toBeGreaterThan(stepIndex(order[i - 1]));
    }
  });

  // Every human-facing installer lands in .release-artifacts/ under the exact
  // name the release event will use — including the unsigned .flatpak, staged
  // here with the rest now that there is no signing gate to defer it past.
  it("stages all seven desktop installers, the Flatpak among them", () => {
    const stage = namedStep("Stage installers for the release event").run;
    expect(stage).toContain('out="$PWD/.release-artifacts"');
    expect(stage).toContain('"$out/Armada-$TAG.AppImage"');
    expect(stage).toContain('"$out/Armada-$TAG.deb"');
    expect(stage).toContain('"$out/Armada-$TAG.exe"');
    expect(stage).toContain('"$out/Armada-$TAG-portable.exe"');
    expect(stage).toContain('"$out/Armada-$TAG-mac-x64.zip"');
    expect(stage).toContain('"$out/Armada-$TAG-mac-arm64.zip"');
    expect(stage).toContain(
      'cp electron/release/Armada-flatpak-*.flatpak "$out/Armada-$TAG.flatpak"',
    );
  });

  // ngit-ci caps a run's exported artifacts at 256 MiB in total; the desktop
  // installers are ~1 GB, so uploading them fails the run after it published.
  it("does not upload the desktop installers as run artifacts", () => {
    const uploads = desktopSteps.filter((step) =>
      String(step.uses || "").startsWith("actions/upload-artifact"),
    );
    expect(uploads).toEqual([]);
  });

  // One writer of the release event, after every build. Kind 30622 is
  // addressable and Nostr has no compare-and-swap, so a second publisher would
  // replace the first's event rather than merge with it, dropping half the
  // artifacts.
  it("publishes the release event from exactly one job, after every build", () => {
    const publishers = Object.entries(workflow.jobs).filter(([, job]) =>
      job.steps.some((step) =>
        String(step.run || "").includes("publish-release.mjs"),
      ),
    );
    expect(publishers.map(([name]) => name)).toEqual(["release"]);
    expect(workflow.jobs.release.needs).toEqual(["android", "desktop"]);
  });

  // `if: always()` runs the job that carries it past an ancestor's failure, but
  // does not rescue the jobs downstream of it. With the Android build first, a
  // Google Play rejection ran the desktop build and then skipped staging — so
  // the build that can be rejected for reasons unrelated to its artifacts goes
  // last, where nothing depends on it.
  it("keeps the Android publish from gating the desktop release", () => {
    expect(workflow.jobs.desktop.needs).toBeUndefined();
    expect(workflow.jobs.android.needs).toEqual(["desktop"]);
    expect(workflow.jobs.android.if).toContain("always()");
  });
});

describe("nsite deploy", () => {
  const nsite = loadYaml(
    fs.readFileSync(
      path.resolve(root, ".ngit/act/workflows/deploy-nsite.yml"),
      "utf8",
    ),
  );

  // The Flatpak fingerprint announcement is gone with the signing key it
  // vouched for. The deploy must not reintroduce a step that gates on it.
  it("no longer verifies a Flatpak signing fingerprint", () => {
    const names = nsite.jobs.deploy.steps.map((step) => step.name);
    expect(names).not.toContain("Verify the published Flatpak key fingerprint");
    const source = fs.readFileSync(
      path.resolve(root, ".ngit/act/workflows/deploy-nsite.yml"),
      "utf8",
    );
    expect(source).not.toContain("armada-flatpak.fingerprint");
  });

  // The nsite deploys from `main` only. A tag carries the same commit, and act
  // derives a container name from the workflow/job names alone, so a tag trigger
  // would collide two runs on one container.
  it("deploys the nsite from main only", () => {
    expect(nsite.on.push.branches).toEqual(["main"]);
    expect(nsite.on.push.tags).toBeUndefined();
    const publishStep = nsite.jobs.deploy.steps.find(
      (step) => step.name === "Publish to Blossom + relays",
    );
    const publishScript = String(publishStep?.run || "");
    expect(publishScript).toContain("scripts/nsite-deploy.sh dist");
    expect(publishScript).not.toContain("nsyte snapshot");
    expect(publishScript).not.toContain("config.title");
  });

  // nsyte runs one upload queue per Blossom server and signs the manifest only
  // after EVERY queue drains, so one broken mirror runs a deploy past its
  // deadline and publishes nothing. Every deploy therefore goes through the
  // probing, bounded wrapper: the site, and the same build again as the
  // release track on a stable release commit.
  it("reaches nsyte only through the probing, bounded wrapper", () => {
    const workflows = ["deploy-nsite.yml", "release.yml"].map((file) =>
      loadYaml(
        fs.readFileSync(
          path.resolve(root, ".ngit/act/workflows", file),
          "utf8",
        ),
      ),
    );
    const invocation = /(^|[\s;|&(])nsyte\s+(deploy|download|upload)\b/;
    const wrapperCalls = [];
    for (const wf of workflows) {
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) {
          const lines = String(step.run || "")
            .split("\n")
            .filter((line) => !line.trim().startsWith("#"));
          for (const line of lines) {
            expect(line, `${step.name}: ${line.trim()}`).not.toMatch(invocation);
            if (/scripts\/nsite-(deploy|download)\.sh/.test(line)) {
              wrapperCalls.push(line.trim());
            }
          }
        }
      }
    }
    expect(wrapperCalls).toEqual([
      "scripts/nsite-deploy.sh dist",
      "scripts/nsite-deploy.sh dist --name armada-release --no-config --fallback /index.html",
    ]);

    // No step may reintroduce the OSTree repository fold.
    for (const file of ["deploy-nsite.yml", "release.yml"]) {
      const source = fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows", file),
        "utf8",
      );
      const active = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n");
      expect(active).not.toContain("armada-fp");
      expect(active).not.toContain("downloads/flatpak");
    }

    const deploy = fs.readFileSync(
      path.resolve(root, "scripts/nsite-deploy.sh"),
      "utf8",
    );
    expect(deploy).toContain('live-hosts.sh" "$servers"');
    expect(deploy).toContain("timeout --signal=TERM --kill-after=30");
    expect(deploy).toMatch(/nsyte deploy "\$dir"[\s\S]*?--sync/);
    expect(deploy).toContain('blamed="$(blamed_servers "$log" "$servers_now")"');
  });

  it("runs the test suite on pushes to every branch", () => {
    const testWorkflow = loadYaml(
      fs.readFileSync(
        path.resolve(root, ".ngit/act/workflows/test.yml"),
        "utf8",
      ),
    );
    const branches = testWorkflow.on.push.branches;
    expect(branches).toContain("*");
    expect(branches).toContain("**");
    expect(testWorkflow.on.push.tags).toBeUndefined();
    expect(Object.hasOwn(testWorkflow.on, "pull_request")).toBe(true);
  });
});
