import { describe, expect, it } from "vitest";

import {
  encodeLocationContent,
  formatCoords,
  isLocationMessage,
  LOCATION_PREFIX,
  parseLocationContent,
  parseLocationEvent,
} from "@/lib/location";

import type { NostrEvent } from "@nostrify/nostrify";

function eventWith(content: string): NostrEvent {
  return { id: "x", pubkey: "p", created_at: 0, kind: 9, content, tags: [], sig: "" };
}

describe("location message format", () => {
  it("encodes a point behind the zero-width marker", () => {
    const content = encodeLocationContent({ lat: 37.7749, lon: -122.4194 });
    expect(content.startsWith(LOCATION_PREFIX)).toBe(true);
    expect(content).toBe(`${LOCATION_PREFIX}37.7749,-122.4194`);
  });

  it("includes rounded accuracy when present", () => {
    const content = encodeLocationContent({ lat: 1, lon: 2, accuracy: 12.6 });
    expect(content).toBe(`${LOCATION_PREFIX}1,2;u=13`);
  });

  it("round-trips through parse", () => {
    const point = { lat: 51.5074, lon: -0.1278, accuracy: 8 };
    const parsed = parseLocationContent(encodeLocationContent(point));
    expect(parsed).toEqual({ lat: 51.5074, lon: -0.1278, accuracy: 8 });
  });

  it("parses without accuracy", () => {
    const parsed = parseLocationContent(`${LOCATION_PREFIX}10,20`);
    expect(parsed).toEqual({ lat: 10, lon: 20, accuracy: undefined });
  });

  it("detects location messages", () => {
    expect(isLocationMessage(eventWith(`${LOCATION_PREFIX}1,2`))).toBe(true);
    expect(isLocationMessage(eventWith("hello world"))).toBe(false);
    expect(isLocationMessage(eventWith("/location 1,2"))).toBe(false); // needs the marker
  });

  it("parses a location out of an event", () => {
    expect(parseLocationEvent(eventWith(`${LOCATION_PREFIX}1.5,2.5`))).toEqual({
      lat: 1.5,
      lon: 2.5,
      accuracy: undefined,
    });
    expect(parseLocationEvent(eventWith("not a location"))).toBeUndefined();
  });

  it("rejects out-of-range or malformed coordinates", () => {
    expect(parseLocationContent(`${LOCATION_PREFIX}91,0`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}0,181`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}abc,def`)).toBeUndefined();
    expect(parseLocationContent("no marker 1,2")).toBeUndefined();
  });

  it("rejects truncated coordinates instead of coercing to Null Island", () => {
    // Number("") is 0 — a truncated body must NOT parse as lat/lon 0.
    expect(parseLocationContent(`${LOCATION_PREFIX}1,`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX},2`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX},`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}1`)).toBeUndefined();
  });

  it("rejects non-decimal numeric literals", () => {
    expect(parseLocationContent(`${LOCATION_PREFIX}0x10,0b1`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}1e2,3`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}Infinity,0`)).toBeUndefined();
    expect(parseLocationContent(`${LOCATION_PREFIX}1,2,3`)).toBeUndefined();
  });

  it("drops meaningless accuracy values but keeps the point", () => {
    expect(parseLocationContent(`${LOCATION_PREFIX}1,2;u=`)).toEqual({
      lat: 1, lon: 2, accuracy: undefined,
    });
    expect(parseLocationContent(`${LOCATION_PREFIX}1,2;u=0`)).toEqual({
      lat: 1, lon: 2, accuracy: undefined,
    });
    expect(parseLocationContent(`${LOCATION_PREFIX}1,2;u=-5`)).toEqual({
      lat: 1, lon: 2, accuracy: undefined,
    });
    expect(parseLocationContent(`${LOCATION_PREFIX}1,2;u=999999999`)).toEqual({
      lat: 1, lon: 2, accuracy: undefined,
    });
  });

  it("formats coordinates for display", () => {
    expect(formatCoords({ lat: 37.7749295, lon: -122.4194155 })).toBe("37.77493, -122.41942");
  });
});
