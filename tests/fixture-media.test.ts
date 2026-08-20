import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fixtureControl from "../fixtures/harmless/control.json";

const fixturePath = fileURLToPath(
  new URL("../fixtures/harmless/harmless-fixture.mp4", import.meta.url),
);

describe("harmless fixture media", () => {
  it("matches the committed physical-evidence hash and byte count", () => {
    const bytes = readFileSync(fixturePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    expect(bytes.byteLength).toBe(fixtureControl.manifest.media.bytes);
    expect(sha256).toBe(fixtureControl.manifest.media.sha256);
    expect(fixtureControl.manifest.source.sourceClass).toBe("fixture");
    expect(fixtureControl.manifest.publicationState).toBe("review");
    expect(Object.values(fixtureControl.rights.grants).every((value) => value === false)).toBe(true);
  });
});
