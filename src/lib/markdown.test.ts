import { describe, expect, it } from "vitest";

import { linkLabelSpoofs, parseInline, parseInlineRun, splitInlineCode, splitMarkdownBlocks, splitMarkdownLinks, withoutCode } from "./markdown";

describe("splitMarkdownBlocks", () => {
  it("passes plain text through as one block", () => {
    expect(splitMarkdownBlocks("hello world")).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("extracts fenced code blocks with language", () => {
    const blocks = splitMarkdownBlocks("before\n```js\nconst x = 1;\n```\nafter");
    expect(blocks).toEqual([
      { type: "text", text: "before\n" },
      { type: "code", lang: "js", code: "const x = 1;" },
      { type: "text", text: "\nafter" },
    ]);
  });

  it("extracts fenced code blocks without language", () => {
    const blocks = splitMarkdownBlocks("```\nplain code\n```");
    expect(blocks).toEqual([{ type: "code", lang: undefined, code: "plain code" }]);
  });

  it("does not link-parse an unclosed fence (stays literal text)", () => {
    const blocks = splitMarkdownBlocks("```\nunclosed");
    expect(blocks).toEqual([{ type: "text", text: "```\nunclosed" }]);
  });

  it("keeps an empty fence literal", () => {
    expect(splitMarkdownBlocks("``````")).toEqual([{ type: "text", text: "``````" }]);
  });

  it("merges consecutive quote lines into one quote block", () => {
    const blocks = splitMarkdownBlocks("> first\n> second\nreply");
    expect(blocks).toEqual([
      { type: "quote", blocks: [{ type: "text", text: "first\nsecond" }] },
      { type: "text", text: "reply" },
    ]);
  });

  it("needs a space after > so emoticons stay literal", () => {
    expect(splitMarkdownBlocks(">:D")).toEqual([{ type: "text", text: ">:D" }]);
    expect(splitMarkdownBlocks(">>:D")).toEqual([{ type: "text", text: ">>:D" }]);
    expect(splitMarkdownBlocks("a\n>.<\nb")).toEqual([{ type: "text", text: "a\n>.<\nb" }]);
    expect(splitMarkdownBlocks(">")).toEqual([{ type: "quote", blocks: [] }]);
  });

  it("keeps quote markers inside code blocks literal", () => {
    const blocks = splitMarkdownBlocks("```\n> not a quote\n```");
    expect(blocks).toEqual([{ type: "code", lang: undefined, code: "> not a quote" }]);
  });

  it("extracts ~~~ fences on lines of their own", () => {
    expect(splitMarkdownBlocks("~~~py\nx = 1\n~~~")).toEqual([{ type: "code", lang: "py", code: "x = 1" }]);
    expect(splitMarkdownBlocks("a ~~~not a fence~~~ b")).toEqual([{ type: "text", text: "a ~~~not a fence~~~ b" }]);
  });

  it("splits a quote's content into blocks, nesting on >>", () => {
    expect(splitMarkdownBlocks("> # H\n> - a\n> - b\n>> deep")).toEqual([
      {
        type: "quote",
        blocks: [
          { type: "heading", level: 1, text: "H" },
          { type: "list", ordered: false, start: 1, items: ["a", "b"] },
          { type: "quote", blocks: [{ type: "text", text: "deep" }] },
        ],
      },
    ]);
  });

  it("stops nesting quotes at a fixed depth", () => {
    const deep = splitMarkdownBlocks(">".repeat(50) + " x");
    let depth = 0;
    let block = deep[0];
    while (block?.type === "quote") {
      depth++;
      block = block.blocks[0];
    }
    expect(depth).toBeLessThanOrEqual(9);
    expect(block).toMatchObject({ type: "text" });
  });

  it("quotes the rest of the message after >>> ", () => {
    expect(splitMarkdownBlocks("intro\n>>> one\n\n- two\nthree")).toEqual([
      { type: "text", text: "intro\n" },
      {
        type: "quote",
        blocks: [
          { type: "text", text: "one" },
          { type: "list", ordered: false, start: 1, items: ["two"] },
          { type: "text", text: "three" },
        ],
      },
    ]);
  });

  it("ignores >>> inside a fence", () => {
    expect(splitMarkdownBlocks("```\n>>> x\n```")).toEqual([{ type: "code", lang: undefined, code: ">>> x" }]);
  });
});

describe("parseInline escapes and emphasis guards", () => {
  it("makes escaped punctuation literal and drops the backslash", () => {
    expect(parseInline("\\*not italic\\*")).toEqual([{ type: "text", value: "*not italic*" }]);
    expect(parseInline("a \\\\ b")).toEqual([{ type: "text", value: "a \\ b" }]);
    expect(parseInline("C:\\Users")).toEqual([{ type: "text", value: "C:\\Users" }]);
  });

  it("keeps escaped characters inside formatting", () => {
    expect(parseInline("**a\\*b**")).toEqual([{ type: "strong", children: [{ type: "text", value: "a*b" }] }]);
  });

  it("keeps a shrug's backslash, and reads Discord's escaped shrug as the same face", () => {
    const shrug = "\u00af\\_(\u30c4)_/\u00af";
    expect(parseInline(shrug)).toEqual([{ type: "text", value: shrug }]);
    expect(parseInline("\u00af\\\\_(\u30c4)_/\u00af")).toEqual([{ type: "text", value: shrug }]);
    expect(parseInline(`I give up ${shrug}`)).toEqual([{ type: "text", value: `I give up ${shrug}` }]);
    expect(parseInline(`**ok ${shrug}**`)).toEqual([{ type: "strong", children: [{ type: "text", value: `ok ${shrug}` }] }]);
    expect(parseInline(`${shrug} _yes_`)).toEqual([
      { type: "text", value: `${shrug} ` },
      { type: "em", children: [{ type: "text", value: "yes" }] },
    ]);
  });

  it("round-trips a literal private-use placeholder character", () => {
    expect(parseInline("x\uE000*y*")).toEqual([
      { type: "text", value: "x\uE000" },
      { type: "em", children: [{ type: "text", value: "y" }] },
    ]);
  });

  it("does not italicize intraword or spaced asterisks", () => {
    expect(parseInline("2*3*4")).toEqual([{ type: "text", value: "2*3*4" }]);
    expect(parseInline("a * b * c")).toEqual([{ type: "text", value: "a * b * c" }]);
  });

  it("spans formatting across atoms", () => {
    expect(parseInlineRun(["**see ", { atom: 1 }, "** and ||", { atom: 2 }, "||"])).toEqual([
      { type: "strong", children: [{ type: "text", value: "see " }, { type: "atom", atom: 1 }] },
      { type: "text", value: " and " },
      { type: "spoiler", children: [{ type: "atom", atom: 2 }] },
    ]);
  });
});

describe("splitInlineCode escapes", () => {
  it("leaves an escaped backtick for the inline pass", () => {
    expect(splitInlineCode("\\`not code\\`")).toEqual([{ code: false, value: "\\`not code\\`" }]);
    expect(splitInlineCode("\\\\`code`")).toEqual([
      { code: false, value: "\\\\" },
      { code: true, value: "code" },
    ]);
  });
});

describe("splitInlineCode", () => {
  it("extracts inline code spans", () => {
    expect(splitInlineCode("use `npm i` to install")).toEqual([
      { code: false, value: "use " },
      { code: true, value: "npm i" },
      { code: false, value: " to install" },
    ]);
  });

  it("leaves unmatched backticks alone", () => {
    expect(splitInlineCode("a ` b")).toEqual([{ code: false, value: "a ` b" }]);
  });
});

describe("parseInline", () => {
  it("parses bold", () => {
    expect(parseInline("a **b** c")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c" },
    ]);
  });

  it("parses italic with * and _", () => {
    expect(parseInline("*a*")).toEqual([
      { type: "em", children: [{ type: "text", value: "a" }] },
    ]);
    expect(parseInline("_a_")).toEqual([
      { type: "em", children: [{ type: "text", value: "a" }] },
    ]);
  });

  it("keeps snake_case literal", () => {
    expect(parseInline("snake_case_name")).toEqual([
      { type: "text", value: "snake_case_name" },
    ]);
  });

  it("parses underline, strikethrough and spoilers", () => {
    expect(parseInline("__u__ ~~s~~ ||sp||")).toEqual([
      { type: "u", children: [{ type: "text", value: "u" }] },
      { type: "text", value: " " },
      { type: "s", children: [{ type: "text", value: "s" }] },
      { type: "text", value: " " },
      { type: "spoiler", children: [{ type: "text", value: "sp" }] },
    ]);
  });

  it("nests bold and italic", () => {
    expect(parseInline("**bold *and italic***")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "bold " },
          { type: "em", children: [{ type: "text", value: "and italic" }] },
        ],
      },
    ]);
  });

  it("leaves whitespace-only delimiters literal", () => {
    expect(parseInline("** **")).toEqual([{ type: "text", value: "** **" }]);
  });

  it("leaves stray asterisks literal", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ type: "text", value: "2 * 3 = 6" }]);
  });
});

describe("splitMarkdownBlocks (chat headings and lists)", () => {
  it("extracts Discord-style headings up to level 3", () => {
    expect(splitMarkdownBlocks("# Title\n## Subtitle\n### Section\nbody")).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "heading", level: 2, text: "Subtitle" },
      { type: "heading", level: 3, text: "Section" },
      { type: "text", text: "body" },
    ]);
  });

  it("keeps level 4+ headings literal in chat (document mode takes all six)", () => {
    expect(splitMarkdownBlocks("#### deep")).toEqual([{ type: "text", text: "#### deep" }]);
    expect(splitMarkdownBlocks("#### deep", true)).toEqual([{ type: "heading", level: 4, text: "deep" }]);
  });

  it("leaves hashtags and bare hashes literal", () => {
    expect(splitMarkdownBlocks("#nostr is neat\n# \nnot a heading")).toEqual([
      { type: "text", text: "#nostr is neat\n# \nnot a heading" },
    ]);
  });

  it("extracts Discord subtext lines", () => {
    expect(splitMarkdownBlocks("main\n-# *small* print\n- item")).toEqual([
      { type: "text", text: "main" },
      { type: "subtext", text: "*small* print" },
      { type: "list", ordered: false, start: 1, items: ["item"] },
    ]);
  });

  it("keeps a subtext marker without a space or mid-line literal", () => {
    expect(splitMarkdownBlocks("-#tag\n-# \na -# b")).toEqual([
      { type: "text", text: "-#tag\n-# \na -# b" },
    ]);
  });

  it("extracts list runs", () => {
    expect(splitMarkdownBlocks("todo:\n- one\n- two\n1. first\n2. second\ndone")).toEqual([
      { type: "text", text: "todo:" },
      { type: "list", ordered: false, start: 1, items: ["one", "two"] },
      { type: "list", ordered: true, start: 1, items: ["first", "second"] },
      { type: "text", text: "done" },
    ]);
  });

  it("keeps emphasis markers that aren't list items literal", () => {
    expect(splitMarkdownBlocks("*italic* and -dash and 1.5 litres")).toEqual([
      { type: "text", text: "*italic* and -dash and 1.5 litres" },
    ]);
  });

  it("passes a chunk without headings or lists through untouched", () => {
    expect(splitMarkdownBlocks("before\n```js\nx\n```\nafter")).toEqual([
      { type: "text", text: "before\n" },
      { type: "code", lang: "js", code: "x" },
      { type: "text", text: "\nafter" },
    ]);
  });

  it("folds the blank line next to an extracted heading into its margin", () => {
    expect(splitMarkdownBlocks("hello\n\n# Title\n\nbody")).toEqual([
      { type: "text", text: "hello" },
      { type: "heading", level: 1, text: "Title" },
      { type: "text", text: "body" },
    ]);
  });

  it("extracts thematic breaks of -, * and _", () => {
    expect(splitMarkdownBlocks("above\n_____\nTest")).toEqual([
      { type: "text", text: "above" },
      { type: "rule" },
      { type: "text", text: "Test" },
    ]);
    for (const rule of ["---", "***", "- - -", " * * * ", "___"]) {
      expect(splitMarkdownBlocks(rule)).toEqual([{ type: "rule" }]);
    }
  });

  it("strips an ATX heading's closing hashes", () => {
    expect(splitMarkdownBlocks("## Title ##\n## C#")).toEqual([
      { type: "heading", level: 2, text: "Title" },
      { type: "heading", level: 2, text: "C#" },
    ]);
  });

  it("reads setext underlines as headings, and --- after a blank line as a rule", () => {
    expect(splitMarkdownBlocks("intro\n\nTitle\n=====\nSub\n---\n\n---")).toEqual([
      { type: "text", text: "intro" },
      { type: "heading", level: 1, text: "Title" },
      { type: "heading", level: 2, text: "Sub" },
      { type: "rule" },
    ]);
  });

  it("keeps short or mixed runs literal", () => {
    expect(splitMarkdownBlocks("--\n-*-\n__x__")).toEqual([{ type: "text", text: "--\n-*-\n__x__" }]);
  });

  it("splits headings alongside quotes and fences", () => {
    expect(splitMarkdownBlocks("> quoted\n## After quote\n```\ncode\n```")).toEqual([
      { type: "quote", blocks: [{ type: "text", text: "quoted" }] },
      { type: "heading", level: 2, text: "After quote" },
      { type: "code", lang: undefined, code: "code" },
    ]);
  });
});

describe("splitMarkdownBlocks (document mode)", () => {
  it("extracts ATX headings with their level", () => {
    expect(splitMarkdownBlocks("## Feature Request\nbody text", true)).toEqual([
      { type: "heading", level: 2, text: "Feature Request" },
      { type: "text", text: "body text" },
    ]);
  });

  it("leaves hashtags and unspaced hashes literal", () => {
    expect(splitMarkdownBlocks("#nostr is neat", true)).toEqual([
      { type: "text", text: "#nostr is neat" },
    ]);
  });

  it("groups consecutive list items, split by ordering", () => {
    expect(splitMarkdownBlocks("- one\n- two\n3. three\n4. four", true)).toEqual([
      { type: "list", ordered: false, start: 1, items: ["one", "two"] },
      { type: "list", ordered: true, start: 3, items: ["three", "four"] },
    ]);
  });

  it("nests an item indented two or more columns under the item above it", () => {
    const [list] = splitMarkdownBlocks("- a\n  - a1\n    1. deep\n  - a2\n- b");
    expect(list).toEqual({
      type: "list", ordered: false, start: 1, items: ["a", "b"],
      children: [{
        type: "list", ordered: false, start: 1, items: ["a1", "a2"],
        children: [{ type: "list", ordered: true, start: 1, items: ["deep"] }],
      }],
    });
  });

  it("keeps one-column indents as siblings and a lone deep-indented item as text", () => {
    expect(splitMarkdownBlocks("- a\n - b")).toEqual([
      { type: "list", ordered: false, start: 1, items: ["a", "b"] },
    ]);
    expect(splitMarkdownBlocks("text\n    - code-like")).toEqual([
      { type: "text", text: "text\n    - code-like" },
    ]);
  });

  it("nests under a tab", () => {
    const [list] = splitMarkdownBlocks("1. one\n\t- sub\n2. two");
    expect(list).toEqual({
      type: "list", ordered: true, start: 1, items: ["one", "two"],
      children: [{ type: "list", ordered: false, start: 1, items: ["sub"] }],
    });
  });

  it("keeps italics literal (a list marker requires a space)", () => {
    expect(splitMarkdownBlocks("*emphasis* stays inline", true)).toEqual([
      { type: "text", text: "*emphasis* stays inline" },
    ]);
  });

  it("folds one boundary newline into the neighbor block", () => {
    expect(splitMarkdownBlocks("## H\n\npara one\n\npara two\n\n- li", true)).toEqual([
      { type: "heading", level: 2, text: "H" },
      { type: "text", text: "para one\n\npara two" },
      { type: "list", ordered: false, start: 1, items: ["li"] },
    ]);
  });

  it("still extracts fences and quotes alongside document blocks", () => {
    expect(splitMarkdownBlocks("# Title\n> quoted\n```\ncode\n```", true)).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "quote", blocks: [{ type: "text", text: "quoted" }] },
      { type: "code", lang: undefined, code: "code" },
    ]);
  });
});

describe("splitMarkdownBlocks (tables)", () => {
  it("parses a GFM table with alignment between text", () => {
    expect(splitMarkdownBlocks("prices:\n| Item | Qty | Cost |\n|:-----|:---:|-----:|\n| tea | 2 | $4 |\n| cake | 1 | $6 |\nthanks")).toEqual([
      { type: "text", text: "prices:" },
      {
        type: "table",
        align: ["left", "center", "right"],
        header: ["Item", "Qty", "Cost"],
        rows: [["tea", "2", "$4"], ["cake", "1", "$6"]],
      },
      { type: "text", text: "thanks" },
    ]);
  });

  it("takes outer pipes as optional and pads or truncates rows to the header", () => {
    expect(splitMarkdownBlocks("a | b\n--- | ---\n1 |\n1 | 2 | 3")).toEqual([
      { type: "table", align: [undefined, undefined], header: ["a", "b"], rows: [["1", ""], ["1", "2"]] },
    ]);
  });

  it("ends at a blank line or a line without a pipe", () => {
    expect(splitMarkdownBlocks("| a |\n| - |\n| 1 |\n\nafter")).toEqual([
      { type: "table", align: [undefined], header: ["a"], rows: [["1"]] },
      { type: "text", text: "after" },
    ]);
    expect(splitMarkdownBlocks("| a |\n| - |\n| 1 |\nafter")).toEqual([
      { type: "table", align: [undefined], header: ["a"], rows: [["1"]] },
      { type: "text", text: "after" },
    ]);
  });

  it("keeps escaped pipes and pipes in inline code inside a cell", () => {
    expect(splitMarkdownBlocks("| op | means |\n|---|---|\n| `a | b` | a or b \\| c |")).toEqual([
      { type: "table", align: [undefined, undefined], header: ["op", "means"], rows: [["`a | b`", "a or b | c"]] },
    ]);
  });

  it("splits on a pipe after an unclosed backtick", () => {
    expect(splitMarkdownBlocks("| a | b |\n|---|---|\n| `x | y |")).toEqual([
      { type: "table", align: [undefined, undefined], header: ["a", "b"], rows: [["`x", "y"]] },
    ]);
  });

  it("needs a delimiter row whose cells match the header", () => {
    const literal = ["a | b\nc | d", "a | b\n--- | --- | ---", "a | b\n--- | x", "a\n|---|"];
    for (const src of literal) {
      expect(splitMarkdownBlocks(src)).toEqual([{ type: "text", text: src }]);
    }
  });

  it("caps a message's table cells, leaving the rows past the cap as text", () => {
    const head = "|a|b|c|d|\n|-|-|-|-|\n";
    const blocks = splitMarkdownBlocks(`${head}${"|\n".repeat(600)}\n${head}|\n`);
    const tables = blocks.filter((b) => b.type === "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(499);
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    expect(text.match(/^\|$/gm)).toHaveLength(102);
  });

  it("parses a table inside a quote", () => {
    expect(splitMarkdownBlocks("> | a |\n> |---|\n> | 1 |")).toEqual([
      { type: "quote", blocks: [{ type: "table", align: [undefined], header: ["a"], rows: [["1"]] }] },
    ]);
  });
});

describe("splitMarkdownLinks", () => {
  it("splits [text](url) links out of a run", () => {
    expect(splitMarkdownLinks("see [F-Droid](https://f-droid.org) today")).toEqual([
      { type: "text", value: "see " },
      { type: "link", text: "F-Droid", url: "https://f-droid.org" },
      { type: "text", value: " today" },
    ]);
  });

  it("reduces image syntax to its bare URL for the media tokenizer", () => {
    expect(splitMarkdownLinks("![shot](https://blossom.example/a.png)")).toEqual([
      { type: "text", value: "https://blossom.example/a.png" },
    ]);
  });

  it("leaves non-http schemes literal", () => {
    expect(splitMarkdownLinks("[x](javascript:alert(1))")).toEqual([
      { type: "text", value: "[x](javascript:alert(1))" },
    ]);
  });

  it("leaves a link literal when its label names another host", () => {
    const src = "[https://armada.buzz/free/nitro/claim](https://nyan.cat/)";
    expect(splitMarkdownLinks(`go ${src}`)).toEqual([
      { type: "text", value: "go " },
      { type: "spoof", text: "https://armada.buzz/free/nitro/claim", url: "https://nyan.cat/" },
    ]);
  });
});

describe("linkLabelSpoofs", () => {
  it("allows plain words and the link's own host", () => {
    expect(linkLabelSpoofs("the docs", "https://example.com/docs")).toBe(false);
    expect(linkLabelSpoofs("github.com/foo", "https://github.com/foo")).toBe(false);
    expect(linkLabelSpoofs("www.GitHub.com", "https://github.com/x")).toBe(false);
    expect(linkLabelSpoofs("see https://example.com/a", "https://www.example.com/b")).toBe(false);
  });

  it("refuses a label naming another host anywhere in it", () => {
    expect(linkLabelSpoofs("https://armada.buzz/free/nitro/claim", "https://nyan.cat/")).toBe(true);
    expect(linkLabelSpoofs("github.com", "https://evil.example/x")).toBe(true);
    expect(linkLabelSpoofs("claim it at armada.buzz now", "https://nyan.cat/")).toBe(true);
    expect(linkLabelSpoofs("evil.github.com", "https://github.com/")).toBe(true);
    expect(linkLabelSpoofs("armada.buzz and nyan.cat", "https://nyan.cat/")).toBe(true);
  });

  it("reads a name as a domain only under a real ICANN suffix", () => {
    expect(linkLabelSpoofs("package.json", "https://github.com/x/package.json")).toBe(false);
    expect(linkLabelSpoofs("edit index.html and app.ts", "https://evil.example/")).toBe(false);
    expect(linkLabelSpoofs("a.zip", "https://evil.example/")).toBe(true);
    expect(linkLabelSpoofs("nyan.cat", "https://evil.example/")).toBe(true);
    expect(linkLabelSpoofs("https://claim.example/x", "https://evil.example/")).toBe(true);
  });

  it("refuses lookalike scripts and compares fullwidth dots as dots", () => {
    expect(linkLabelSpoofs("\u0430rmada.buzz", "https://armada.buzz/")).toBe(true);
    expect(linkLabelSpoofs("armada\uFF0Ebuzz", "https://nyan.cat/")).toBe(true);
    expect(linkLabelSpoofs("armada\uFF0Ebuzz", "https://armada.buzz/")).toBe(false);
  });
});

describe("withoutCode", () => {
  it("blanks fenced and inline code, keeping offsets", () => {
    const src = "see https://a.example\n```\nhttps://b.example/x.png\n```\nand `nostr:npub1x` #tag";
    const out = withoutCode(src);
    expect(out).toHaveLength(src.length);
    expect(out).toContain("https://a.example");
    expect(out).not.toContain("b.example");
    expect(out).not.toContain("npub1x");
    expect(out.indexOf("#tag")).toBe(src.indexOf("#tag"));
  });

  it("leaves an unclosed or empty fence as text, as it renders", () => {
    expect(withoutCode("```\nhttps://a.example")).toBe("```\nhttps://a.example");
    expect(withoutCode("`````` https://a.example")).toBe("`````` https://a.example");
  });
});

describe("splitMarkdownBlocks single-line fence", () => {
  it("takes no language without a newline", () => {
    expect(splitMarkdownBlocks("```https://a.example/x```")).toEqual([
      { type: "code", lang: undefined, code: "https://a.example/x" },
    ]);
  });
});
