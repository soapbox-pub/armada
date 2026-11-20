import { readFileSync } from "node:fs";

import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import { describe, expect, it } from "vitest";

// Modal layers write to <body> on every open and close (Radix's inline
// `pointer-events: none`, react-remove-scroll-bar's `data-scroll-locked` and its
// variable). Whatever reaches every element from there restyles the whole
// document twice per dialog: ~0.3 s apiece on a phone. See AGENTS.md,
// "Performance rules that have regressed before".

const css = postcss.parse(readFileSync("src/index.css", "utf8"));

/** Selectors that test an attribute of <body> and then descend from it. */
function descendFromBodyAttribute(selector: string): boolean {
  let found = false;
  selectorParser((root) => {
    root.each((sel) => {
      let bodyWithAttribute = false;
      let compoundIsBody = false;
      let compoundHasAttribute = false;
      sel.walk((node) => {
        if (node.type === "combinator") {
          if (compoundIsBody && compoundHasAttribute) bodyWithAttribute = true;
          if (bodyWithAttribute) found = true;
          compoundIsBody = compoundHasAttribute = false;
        } else if (node.type === "tag" && node.value === "body") compoundIsBody = true;
        else if (node.type === "attribute") compoundHasAttribute = true;
      });
    });
  }).processSync(selector);
  return found;
}

describe("index.css", () => {
  it("never matches a descendant through an attribute of <body>", () => {
    const offending: string[] = [];
    css.walkRules((rule) => {
      if (descendFromBodyAttribute(rule.selector)) offending.push(rule.selector);
    });
    expect(offending, "set a custom property on body and read it below instead").toEqual([]);
  });

  it("registers the scroll lock's body variable as non-inherited", () => {
    let registered: Record<string, string> | undefined;
    css.walkAtRules("property", (at) => {
      if (at.params.trim() !== "--removed-body-scroll-bar-size") return;
      registered = {};
      at.walkDecls((d) => void (registered![d.prop] = d.value));
    });
    expect(registered?.inherits).toBe("false");
  });

  it("recognizes the shapes the first rule exists to catch", () => {
    expect(descendFromBodyAttribute(':where(body:not([style*="pointer-events: none"])) .timeline-row > *')).toBe(true);
    expect(descendFromBodyAttribute("body[data-scroll-locked] .row")).toBe(true);
    expect(descendFromBodyAttribute('body[style*="pointer-events: none"]')).toBe(false);
    expect(descendFromBodyAttribute(".timeline-row > *")).toBe(false);
    expect(descendFromBodyAttribute("html[data-reduce-motion] *")).toBe(false);
  });
});
