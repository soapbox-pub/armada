// @vitest-environment node

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const readme = fs.readFileSync(
  path.resolve(process.cwd(), "electron/README.md"),
  "utf8",
);
const flatpakDocs = readme.slice(
  readme.indexOf("## Flatpak"),
  readme.indexOf("## CI"),
);
const shellBlocks = [...flatpakDocs.matchAll(/```sh\n([\s\S]*?)```/g)].map(
  ([, commands]) => commands,
);
// Prose is hard-wrapped at 80 columns, so a sentence a reader sees as one line
// is not one line in the file. Assert prose against a whitespace-collapsed copy;
// command text keeps using `shellBlocks`, where the exact bytes are the point.
const flatpakProse = flatpakDocs.replace(/\s+/g, " ");

describe("Flatpak documentation", () => {
  it("points installs at the pkg.soapbox.pub (npkg) remote", () => {
    const installsRef = shellBlocks.some(
      (commands) =>
        commands.includes("flatpak install --user") &&
        commands.includes(
          "https://pkg.soapbox.pub/flatpak/soapbox.pub/buzz.armada.app/buzz.armada.app.flatpakref",
        ),
    );
    expect(installsRef).toBe(true);
    expect(flatpakProse).toContain("pkg.soapbox.pub");
  });

  // npkg re-signs on import; Armada ships an unsigned bundle. The docs must not
  // describe a self-hosted signing key, an out-of-band fingerprint, or the
  // committed announcement file — all of which were retired with it.
  it("keeps no self-hosted signing apparatus", () => {
    expect(flatpakDocs).not.toContain("FLATPAK_GPG");
    expect(flatpakDocs).not.toContain("armada-flatpak.fingerprint");
    expect(flatpakDocs).not.toContain("nak req -k 35128");
    expect(flatpakProse).toContain("Armada does not sign this bundle");
  });

  // The self-hosted OSTree remote is gone. Instructions that add it would hand
  // users a dead origin, and disabling GPG verification is only ever for the
  // local file:// build repo.
  it("never adds the retired hosted remote, and only disables verification for a local repo", () => {
    for (const commands of shellBlocks) {
      expect(commands).not.toContain("armada.buzz/downloads/flatpak/");
      if (commands.includes("--no-gpg-verify")) {
        expect(commands).toContain("file://");
      }
    }
  });

  it("documents both update paths: the web bundle in place and the shell via flatpak update", () => {
    expect(flatpakProse).toContain("The web bundle updates in place");
    expect(flatpakProse).toContain(
      "`checkForWebUpdate` in `electron/main.js`",
    );
    expect(flatpakProse).toContain("The shell updates through `flatpak update`");
  });

  it("keeps older-install recovery without deleting profiles", () => {
    // The now-dead origin embedded in older self-hosted bundles is disabled,
    // not deleted, and the profile is preserved.
    expect(flatpakDocs).toContain(
      'flatpak remote-modify --user --disable \\\n  "$(flatpak info --user --show-origin buzz.armada.app)"',
    );
    expect(flatpakDocs).toContain(
      "sudo flatpak uninstall --system buzz.armada.app",
    );
    expect(flatpakProse).toContain("Do not add `--delete-data`");
    expect(flatpakProse).toContain(
      "keeps the profile under `~/.var/app/buzz.armada.app`",
    );
  });
});
