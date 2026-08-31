import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("storyboard-brand-manifest.json", "utf8"));
if (manifest.schemaVersion !== "tmg.storyboard-manifest.v1.1") {
  throw new Error("unexpected StoryboardManifest schema");
}

const entries = [];
for (let targetIndex = 0; targetIndex < manifest.targets.length; targetIndex += 1) {
  const target = manifest.targets[targetIndex];
  for (let shotIndex = 0; shotIndex < target.shots.length; shotIndex += 1) {
    const shot = target.shots[shotIndex];
    entries.push({
      localFile: `storyboard-brand-generated-${targetIndex + 1}-${shotIndex + 1}.bin`,
      objectKey: shot.generatedFrame.objectKey,
    });
    entries.push({
      localFile: `storyboard-brand-composed-${targetIndex + 1}-${shotIndex + 1}.webp`,
      objectKey: shot.composedFrame.objectKey,
    });
  }
  entries.push({
    localFile: `storyboard-brand-title-${targetIndex + 1}.webp`,
    objectKey: target.titleCard.objectKey,
  });
  entries.push({
    localFile: `storyboard-brand-end-${targetIndex + 1}.webp`,
    objectKey: target.endCard.objectKey,
  });
}

fs.writeFileSync(
  "storyboard-brand-retrieval-index.tsv",
  entries.map((entry) => `${entry.localFile}\t${entry.objectKey}`).join("\n") + "\n",
);
fs.writeFileSync(
  "storyboard-brand-retrieval-index.json",
  JSON.stringify({ schemaVersion: "tmg.storyboard-brand-retrieval-index.v1.1", entries }, null, 2) + "\n",
);
console.log(JSON.stringify({ artifactCount: entries.length }));
