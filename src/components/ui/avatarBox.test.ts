import { describe, expect, it } from "vitest";

import { boxFromClasses } from "./avatarBox";

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
