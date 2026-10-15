import { describe, expect, it } from "bun:test";
import { toSearchUrl } from "./searchBatches";

describe("toSearchUrl", () => {
  it("keeps URLs, adds a missing scheme, and turns keywords into a people search", () => {
    const url = "https://www.linkedin.com/search/results/people/?keywords=cto";
    expect(toSearchUrl(` ${url} `)).toBe(url);
    expect(toSearchUrl("www.linkedin.com/search/results/people/?keywords=cto")).toBe(url);
    expect(toSearchUrl("sales manager pune")).toBe("https://www.linkedin.com/search/results/people/?keywords=sales%20manager%20pune");
    expect(toSearchUrl("  ")).toBe("");
  });
});
