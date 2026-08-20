import crypto from "node:crypto";
import fs from "node:fs";

const expectedSha256 = "a4d859d027c3d1a1aa31d1d391b3e0db7e4cbec05b865db3713d851c86b49118";
const expectedBytes = 1441;

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

const mediaPath = process.env.ACCEPT_MEDIA_PATH ?? "/tmp/tmg-accept-media.mp4";
const manifest = readJson(process.env.ACCEPT_MANIFEST_PATH ?? "/tmp/tmg-accept-manifest.json");
const rights1 = readJson(process.env.ACCEPT_RIGHTS1_PATH ?? "/tmp/tmg-accept-rights-r1.json");
const rights2 = readJson(process.env.ACCEPT_RIGHTS2_PATH ?? "/tmp/tmg-accept-rights-r2.json");
const receipt = readJson(process.env.ACCEPT_RECEIPT_PATH ?? "/tmp/tmg-accept-receipt.json");
const event = readJson(process.env.ACCEPT_EVENT_PATH ?? "/tmp/tmg-accept-revocation.json");

const bytes = fs.readFileSync(mediaPath);
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
if (bytes.length !== expectedBytes) {
  throw new Error(`R2 media byte count changed: ${bytes.length}`);
}
if (digest !== expectedSha256) {
  throw new Error(`R2 media SHA-256 changed: ${digest}`);
}

if (manifest.assetId !== "harmless_fixture_001" || manifest.publicationState !== "review") {
  throw new Error("canonical manifest was not preserved as review-only fixture evidence");
}
if (rights1.evidenceState !== "verified" || rights1.revision !== 1) {
  throw new Error("original rights revision was not preserved");
}
if (rights2.evidenceState !== "revoked" || rights2.revision !== 2 || !rights2.revokedAt) {
  throw new Error("revoked rights revision was not persisted correctly");
}
for (const [grant, value] of Object.entries(rights2.grants ?? {})) {
  if (value !== false) throw new Error(`revoked grant ${grant} must be false`);
}
if (receipt.status !== "revoked" || !receipt.revokeMutationId || receipt.vectorIds?.length !== 1) {
  throw new Error("index receipt does not prove one-vector revocation");
}
if (event.deletedVectorIds?.length !== 1 || !event.deletionMutationId) {
  throw new Error("revocation event does not prove one-vector deletion request");
}

const evidence = {
  schemaVersion: "1.0.0",
  verdict: "pass",
  assetId: manifest.assetId,
  publicationState: manifest.publicationState,
  mediaEvidence: {
    bytes: bytes.length,
    sha256: digest,
    preservedAfterRevocation: true,
  },
  rightsEvidence: {
    originalRevision: rights1.revision,
    revokedRevision: rights2.revision,
    revokedAt: rights2.revokedAt,
    allCommercialGrantsDisabled: Object.values(rights2.grants ?? {}).every((value) => value === false),
  },
  vectorEvidence: {
    vectorIds: receipt.vectorIds,
    revokeMutationId: receipt.revokeMutationId,
    receiptStatus: receipt.status,
  },
  revocationEvent: {
    deletionMutationId: event.deletionMutationId,
    deletedVectorCount: event.deletedVectorIds.length,
    reason: event.reason,
  },
};

const out = process.env.ACCEPT_EVIDENCE_OUT ?? "acceptance-evidence.json";
fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence));
