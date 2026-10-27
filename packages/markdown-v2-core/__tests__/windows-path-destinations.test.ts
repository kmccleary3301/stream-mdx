import assert from "node:assert/strict";
import { parser as markdownParser } from "@lezer/markdown";

import { InlineParser } from "../src/inline-parser";
import { collectLinkReferences } from "../src/inline/reference-collector";

const linkDestinations = { windowsDrivePaths: "preserve" as const };
const inlineParser = new InlineParser({ maxCacheEntries: 0, linkDestinations });
const drivePath = String.raw`C:\repo\.t3\file.png`;
const uncPath = String.raw`\\server\share\.t3\file.png`;

const driveLink = inlineParser.parse(`[open](${drivePath})`, { cache: false });
assert.equal(driveLink[0]?.kind, "link");
if (driveLink[0]?.kind === "link") assert.equal(driveLink[0].href, drivePath);

const driveImage = inlineParser.parse(`![image](${drivePath})`, { cache: false });
assert.equal(driveImage[0]?.kind, "image");
if (driveImage[0]?.kind === "image") assert.equal(driveImage[0].src, drivePath);

const uncLink = inlineParser.parse(`[unc](${uncPath})`, { cache: false });
assert.equal(uncLink[0]?.kind, "link");
if (uncLink[0]?.kind === "link") assert.equal(uncLink[0].href, uncPath);

const referenceSource = `[open][source]\n\n[source]: ${drivePath}`;
const references = collectLinkReferences(markdownParser.parse(referenceSource), referenceSource, linkDestinations);
assert.equal(references.get("source")?.href, drivePath);
const referenceLink = new InlineParser({ maxCacheEntries: 0, references, linkDestinations })
  .parse("[open][source]", { cache: false });
assert.equal(referenceLink[0]?.kind, "link");
if (referenceLink[0]?.kind === "link") assert.equal(referenceLink[0].href, drivePath);

const ordinaryEscape = inlineParser.parse(String.raw`[escaped](plain\.txt)`, { cache: false });
assert.equal(ordinaryEscape[0]?.kind, "link");
if (ordinaryEscape[0]?.kind === "link") assert.equal(ordinaryEscape[0].href, "plain.txt");

console.log("Windows destination tests passed");
