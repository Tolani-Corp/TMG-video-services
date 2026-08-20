import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const controlUrl = new URL("../fixtures/harmless/control.json", import.meta.url);
const mediaUrl = new URL("../fixtures/harmless/harmless-fixture.mp4", import.meta.url);
const control = JSON.parse(await readFile(controlUrl, "utf8"));
const media = await readFile(mediaUrl);
const sha256 = createHash("sha256").update(media).digest("hex");

const failures = [];
if (media.byteLength !== control.manifest.media.bytes) {
  failures.push(`byte count mismatch: ${media.byteLength} != ${control.manifest.media.bytes}`);
}
if (sha256 !== control.manifest.media.sha256) {
  failures.push(`sha256 mismatch: ${sha256} != ${control.manifest.media.sha256}`);
}
if (control.manifest.source.sourceClass !== "fixture") {
  failures.push("fixture sourceClass must be fixture");
}
if (control.manifest.publicationState !== "review") {
  failures.push("fixture publicationState must remain review");
}
for (const [grant, value] of Object.entries(control.rights.grants)) {
  if (value !== false) failures.push(`fixture grant ${grant} must remain false`);
}

if (failures.length > 0) {
  console.error("fixture verification failed");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`fixture verified: ${media.byteLength} bytes sha256=${sha256}`);
console.log(JSON.stringify(control));
