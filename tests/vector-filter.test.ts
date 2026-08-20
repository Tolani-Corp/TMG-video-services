import { describe, expect, it } from "vitest";
import { buildCoarseVectorFilter } from "../src/vectorize";

describe("buildCoarseVectorFilter", () => {
  it("projects MCP rights and publication approval into Vectorize metadata filters", () => {
    expect(
      buildCoarseVectorFilter({
        queryVector: [0, 1],
        topK: 10,
        namespace: "tenant_1",
        tenantId: "tenant_1",
        purpose: "mcp",
      }),
    ).toEqual({
      tenantId: "tenant_1",
      rightsVerified: true,
      publicationState: "approved",
      mcp: true,
    });
  });

  it("does not require publication approval for internal search", () => {
    expect(
      buildCoarseVectorFilter({
        queryVector: [0, 1],
        topK: 10,
        namespace: "tenant_1",
        tenantId: "tenant_1",
        purpose: "internal_search",
      }),
    ).toEqual({
      tenantId: "tenant_1",
      rightsVerified: true,
    });
  });
});
