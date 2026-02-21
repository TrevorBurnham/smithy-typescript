import { describe, expect, test as it } from "vitest";

import { resolvedPath } from "./resolve-path";

describe("resolvedPath", () => {
  const basePath = "/items/{itemId}";
  const uriLabel = "{itemId}";

  it("replaces the label with the encoded value", () => {
    const result = resolvedPath(basePath, { itemId: "abc" }, "itemId", () => "abc", uriLabel, false);
    expect(result).toBe("/items/abc");
  });

  it("encodes greedy labels segment by segment", () => {
    const result = resolvedPath(basePath, { itemId: "a/b/c" }, "itemId", () => "a/b/c", uriLabel, true);
    expect(result).toBe("/items/a/b/c");
  });

  it("throws when labelValueProvider returns undefined", () => {
    expect(() => resolvedPath(basePath, { itemId: "x" }, "itemId", () => undefined, uriLabel, false)).toThrow(
      "Empty value provided for input HTTP label: itemId."
    );
  });

  it("throws when labelValueProvider returns null", () => {
    expect(() =>
      resolvedPath(basePath, { itemId: "x" }, "itemId", () => null as unknown as string, uriLabel, false)
    ).toThrow("Empty value provided for input HTTP label: itemId.");
  });

  it("throws when labelValueProvider returns an empty string", () => {
    expect(() => resolvedPath(basePath, { itemId: "x" }, "itemId", () => "", uriLabel, false)).toThrow(
      "Empty value provided for input HTTP label: itemId."
    );
  });

  it("throws when the member is not present in input", () => {
    expect(() => resolvedPath(basePath, {}, "itemId", () => "abc", uriLabel, false)).toThrow(
      "No value provided for input HTTP label: itemId."
    );
  });
});
