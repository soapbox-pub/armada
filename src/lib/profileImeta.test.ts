import { describe, expect, it } from "vitest";

import { carriedProfileTags, imetaFor, imetaTagFromUpload, parseProfileImeta, profileImetaTags } from "./profileImeta";

const PIC = "https://blossom.example/aa.jpg";
const BANNER = "https://blossom.example/bb";

describe("parseProfileImeta", () => {
  it("matches each field to the tag naming its exact URL", () => {
    const imeta = parseProfileImeta(
      [
        ["imeta", `url ${PIC}`, "m image/jpeg", "fallback https://mirror.example/aa.jpg"],
        [
          "imeta",
          `url ${BANNER}`,
          "m image/webp",
          "encryption-algorithm aes-gcm",
          `decryption-key ${"0".repeat(64)}`,
          `decryption-nonce ${"0".repeat(32)}`,
        ],
        ["imeta", "url https://blossom.example/old.jpg", "m image/png"],
      ],
      { picture: PIC, banner: BANNER },
    );
    expect(imeta?.picture?.fallbacks).toEqual(["https://mirror.example/aa.jpg"]);
    expect(imeta?.banner?.encryption?.algorithm).toBe("aes-gcm");
  });

  it("ignores tags describing images the profile no longer uses", () => {
    expect(parseProfileImeta([["imeta", "url https://blossom.example/old.jpg"]], { picture: PIC })).toBeUndefined();
    expect(parseProfileImeta([], { picture: PIC })).toBeUndefined();
  });
});

describe("imetaFor", () => {
  it("applies an entry only to the URL it describes", () => {
    const entry = { url: PIC };
    expect(imetaFor(PIC, entry)).toBe(entry);
    expect(imetaFor("https://blossom.example/cc.jpg", entry)).toBeUndefined();
    expect(imetaFor(undefined, entry)).toBeUndefined();
  });
});

describe("profileImetaTags", () => {
  const uploaded = imetaTagFromUpload([["url", PIC], ["x", "aa"], ["m", "image/jpeg"], ["dim", ""]]);

  it("builds an imeta tag from upload tags, dropping empty fields", () => {
    expect(uploaded).toEqual(["imeta", `url ${PIC}`, "x aa", "m image/jpeg"]);
  });

  it("prefers this session's upload, keeps unchanged images' tags, and drops the rest", () => {
    const previous = [
      ["imeta", `url ${PIC}`, "m image/png"],
      ["imeta", `url ${BANNER}`, "m image/webp"],
      ["imeta", "url https://blossom.example/gone.jpg"],
      ["t", "unrelated"],
    ];
    expect(profileImetaTags({ picture: PIC, banner: BANNER }, [uploaded, ...previous])).toEqual([
      uploaded,
      ["imeta", `url ${BANNER}`, "m image/webp"],
    ]);
  });

  it("describes a URL used for both fields once", () => {
    expect(profileImetaTags({ picture: PIC, banner: PIC }, [uploaded])).toEqual([uploaded]);
  });

  it("gives a hand-typed URL nothing", () => {
    expect(profileImetaTags({ picture: "https://pics.example/me.jpg" }, [uploaded])).toEqual([]);
  });
});

describe("carriedProfileTags", () => {
  it("keeps emoji and other tags, dropping imeta and mirrored content fields", () => {
    const prev = [
      ["emoji", "H", "https://example.com/h.png"],
      ["alt", "User profile"],
      ["name", ":H:enk"],
      ["picture", PIC],
      ["imeta", `url ${PIC}`],
      ["published_at", "1700000000"],
    ];
    expect(carriedProfileTags(prev, ["name", "picture", "about"])).toEqual([
      ["emoji", "H", "https://example.com/h.png"],
      ["alt", "User profile"],
      ["published_at", "1700000000"],
    ]);
  });
});
