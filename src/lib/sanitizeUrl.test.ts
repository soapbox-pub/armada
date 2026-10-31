import { describe, expect, it } from "vitest";

import { isLocalNetworkUrl, isMagnetUri, sanitizeUrl } from "./sanitizeUrl";

describe("sanitizeUrl", () => {
  it("passes http(s) URLs", () => {
    expect(sanitizeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeUrl("http://example.com/a")).toBe("http://example.com/a");
  });

  it("rejects other schemes and junk", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeUrl("lightning:lnbc1")).toBeUndefined();
    expect(sanitizeUrl("not a url")).toBeUndefined();
    expect(sanitizeUrl(null)).toBeUndefined();
  });
});

describe("isLocalNetworkUrl", () => {
  it("flags loopback / localhost", () => {
    expect(isLocalNetworkUrl("http://localhost:8080/e.gif")).toBe(true);
    expect(isLocalNetworkUrl("http://foo.localhost/e.gif")).toBe(true);
    expect(isLocalNetworkUrl("http://127.0.0.1/x")).toBe(true);
    expect(isLocalNetworkUrl("https://127.1.2.3/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[::1]:3000/x")).toBe(true);
    expect(isLocalNetworkUrl("http://0.0.0.0/x")).toBe(true);
  });

  it("flags private + link-local + mDNS ranges", () => {
    expect(isLocalNetworkUrl("http://10.0.0.5/x")).toBe(true);
    expect(isLocalNetworkUrl("http://192.168.1.5/x")).toBe(true);
    expect(isLocalNetworkUrl("http://172.16.0.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://172.31.255.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://169.254.10.1/x")).toBe(true);
    expect(isLocalNetworkUrl("http://myhost.local/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[fe80::1]/x")).toBe(true);
    expect(isLocalNetworkUrl("http://[fd12::1]/x")).toBe(true);
  });

  it("allows public hosts (incl. public IPs outside private ranges)", () => {
    expect(isLocalNetworkUrl("https://blossom.ditto.pub/e.gif")).toBe(false);
    expect(isLocalNetworkUrl("https://8.8.8.8/x")).toBe(false);
    expect(isLocalNetworkUrl("https://172.15.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl("https://172.32.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl("https://11.0.0.1/x")).toBe(false);
    expect(isLocalNetworkUrl(null)).toBe(false);
    expect(isLocalNetworkUrl("garbage")).toBe(false);
  });
});

describe('IPv4-mapped IPv6 literals', () => {
  it('catches a loopback wearing an IPv6 spelling', () => {
    // The URL parser normalizes the mapped form to hex, so the dotted rules
    // below never see it — the same host, spelled past the guard.
    expect(isLocalNetworkUrl('http://[::ffff:127.0.0.1]/x.png')).toBe(true);
    expect(isLocalNetworkUrl('http://[::ffff:192.168.1.5]/x.png')).toBe(true);
    expect(isLocalNetworkUrl('http://[::ffff:10.0.0.1]/x.png')).toBe(true);
    expect(isLocalNetworkUrl('http://[::ffff:169.254.1.1]/x.png')).toBe(true);
  });

  it('still allows a mapped public address', () => {
    expect(isLocalNetworkUrl('http://[::ffff:93.184.216.34]/x.png')).toBe(false);
  });
});

describe("isMagnetUri", () => {
  it("accepts a magnet naming its content by BitTorrent hash", () => {
    expect(isMagnetUri("magnet:?xt=urn:btih:D0F23C109D8662A3FE9338F75839AF8D57E5D4A9&dn=Ubuntu&tr=udp%3A%2F%2Ft.example%3A80")).toBe(true);
    expect(isMagnetUri("magnet:?dn=x&xt=urn:btmh:1220abcdef")).toBe(true);
  });

  it("refuses anything else spelled magnet:", () => {
    expect(isMagnetUri("magnet:?dn=no-hash")).toBe(false);
    expect(isMagnetUri("magnet:?xt=urn:sha1:abc")).toBe(false);
    expect(isMagnetUri("magnet:xt=urn:btih:abc")).toBe(false);
    expect(isMagnetUri(`magnet:?xt=urn:btih:abc&tr=${"a".repeat(9000)}`)).toBe(false);
  });
});
