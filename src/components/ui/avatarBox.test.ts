import { describe, expect, it } from "vitest";

import { boxFromClasses, splitDecor } from "./avatarBox";

describe("boxFromClasses", () => {
  it("reads the avatar's size from its classes, the base 40px otherwise", () => {
    expect(boxFromClasses(undefined)).toBe(40);
    expect(boxFromClasses("size-10 cursor-pointer")).toBe(40);
    expect(boxFromClasses("size-4")).toBe(16);
    expect(boxFromClasses("h-12 w-12 ring-2")).toBe(48);
    expect(boxFromClasses("size-[52px]")).toBe(52);
    expect(boxFromClasses("size-9 touch:size-11 md:size-7")).toBe(36);
  });

  it("leaves a size it can't read to be measured", () => {
    expect(boxFromClasses("size-full")).toBeUndefined();
    expect(boxFromClasses("h-full w-full")).toBeUndefined();
  });
});

describe("splitDecor", () => {
  it("keeps layout on the wrapper and box decorations on the masked avatar", () => {
    expect(splitDecor("shadow-xl size-20 opacity-80")).toEqual(["size-20 opacity-80", "shadow-xl"]);
    expect(splitDecor("size-20 md:size-24 border-4 border-background")).toEqual(["size-20 md:size-24", "border-4 border-background"]);
    expect(splitDecor("size-5 ring-2 ring-chrome hover:ring-primary")).toEqual(["size-5", "ring-2 ring-chrome hover:ring-primary"]);
    expect(splitDecor("relative size-16 border-[3px]")).toEqual(["relative size-16", "border-[3px]"]);
    expect(splitDecor(undefined)).toEqual(["", ""]);
  });
});
