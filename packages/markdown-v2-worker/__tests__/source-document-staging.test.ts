import assert from "node:assert";
import { parser as nativeParser } from "@lezer/markdown";
import { AppendSourceDocument, createSourceWindow } from "@stream-mdx/core";

function main(): void {
  const document = new AppendSourceDocument();
  document.append("heading\r");
  const initialSnapshot = document.snapshot();
  const abandoned = document.stageAppend("\nbody \uD83D");
  const preparedSource = "heading\r\nbody \uD83D";

  assert.strictEqual(document.snapshot(), initialSnapshot, "preparation leaves the canonical snapshot unchanged");
  assert.strictEqual(document.length, "heading\r".length, "preparation does not append offered source");
  assert.strictEqual(
    nativeParser.parse(abandoned.snapshot).toString(),
    nativeParser.parse(preparedSource).toString(),
    "native Lezer consumes a staged reader across a split CRLF",
  );
  assert.strictEqual(abandoned.snapshot.chunk(0), "heading\r", "line chunks find the staged LF beyond the old tail");

  // Discard needs no mutation or rollback; a retry is based on the same canonical source.
  const retry = document.stageAppend("\nbody \uD83D");
  assert.strictEqual(
    nativeParser.parse(retry.snapshot).toString(),
    nativeParser.parse(preparedSource).toString(),
    "a retry does not chain the abandoned staged suffix",
  );
  assert.strictEqual(retry.commit(), true, "an unchanged canonical base accepts the staged append");
  assert.strictEqual(retry.commit(), true, "a successful commit is idempotent");
  assert.strictEqual(
    document.snapshot().materialize(),
    preparedSource,
    "commit appends the staged suffix to canonical source",
  );
  const canonicalAfterRetry = document.snapshot();

  const bodyFrom = "heading\r\n".length;
  const retainedWindow = createSourceWindow(retry.snapshot, bodyFrom, retry.snapshot.length);
  const next = document.stageAppend("\uDE03\r\nfinal\n");
  const completeSource = "heading\r\nbody \uD83D\uDE03\r\nfinal\n";
  const finalLineWindow = createSourceWindow(next.snapshot, bodyFrom, completeSource.length - 1);

  assert.strictEqual(document.snapshot(), canonicalAfterRetry, "preparation leaves the canonical base unchanged");
  assert.strictEqual(
    nativeParser.parse(next.snapshot).toString(),
    nativeParser.parse(completeSource).toString(),
    "native Lezer consumes the staged low surrogate and appended CRLF exactly",
  );
  assert.strictEqual(
    next.snapshot.chunk(bodyFrom),
    "body \uD83D\uDE03\r",
    "lineChunks continue the old partial line through the staged suffix to its next LF",
  );
  assert.strictEqual(
    next.snapshot.read(bodyFrom + 5, bodyFrom + 7),
    "\uD83D\uDE03",
    "read preserves a surrogate pair split at append",
  );
  assert.strictEqual(
    finalLineWindow.chunk(0),
    "body \uD83D\uDE03\r",
    "a nonzero-origin window preserves CRLF line chunks",
  );
  assert.strictEqual(
    finalLineWindow.chunk(9),
    "final",
    "a window caps a line chunk at its captured end",
  );
  assert.strictEqual(finalLineWindow.chunk(finalLineWindow.length), "", "a window cannot read past its captured end");
  assert.strictEqual(
    nativeParser.parse(finalLineWindow).toString(),
    nativeParser.parse("body \uD83D\uDE03\r\nfinal").toString(),
    "native Lezer consumes a window whose origin is inside the canonical document",
  );

  assert.strictEqual(next.commit(), true, "the second staged append commits against its exact canonical base");
  assert.strictEqual(next.commit(), true, "repeating a successful commit remains successful");
  assert.strictEqual(
    document.snapshot().materialize(),
    completeSource,
    "commit appends only the offered suffix to canonical source",
  );

  const afterExtensionSource = `${completeSource}extension\n`;
  document.append("extension\n");
  assert.strictEqual(next.commit(), true, "a committed result stays idempotent after later appends");
  assert.strictEqual(
    document.snapshot().materialize(),
    afterExtensionSource,
    "repeated commit does not overwrite newer canonical source",
  );
  assert.strictEqual(
    initialSnapshot.materialize(),
    "heading\r",
    "the original canonical snapshot remains capped",
  );
  assert.strictEqual(initialSnapshot.chunk(0), "heading\r", "the original snapshot retains its old line");
  assert.strictEqual(
    retry.snapshot.materialize(),
    preparedSource,
    "an old staged snapshot remains capped after later appends",
  );
  assert.strictEqual(
    retainedWindow.materialize(),
    "body \uD83D",
    "an old nonzero-origin window remains capped after later appends",
  );
  assert.strictEqual(
    nativeParser.parse(retainedWindow).toString(),
    nativeParser.parse("body \uD83D").toString(),
    "a retained window remains a stable native parser input",
  );
  assert.strictEqual(
    nativeParser.parse(finalLineWindow).toString(),
    nativeParser.parse("body \uD83D\uDE03\r\nfinal").toString(),
    "a window over a committed snapshot remains capped after later appends",
  );
  assert.strictEqual(
    nativeParser.parse(next.snapshot).toString(),
    nativeParser.parse(completeSource).toString(),
    "a committed staged reader remains capped after later appends",
  );

  const stale = document.stageAppend("stale\n");
  const staleSource = `${completeSource}extension\nstale\n`;
  assert.strictEqual(
    nativeParser.parse(stale.snapshot).toString(),
    nativeParser.parse(staleSource).toString(),
    "a staged reader remains independently readable before commit",
  );
  document.append("intervening\n");
  const currentSnapshot = document.snapshot();
  const currentSource = `${completeSource}extension\nintervening\n`;
  assert.strictEqual(stale.commit(), false, "a stale staged append is rejected");
  assert.strictEqual(currentSnapshot.materialize(), currentSource, "stale rejection preserves exact canonical source");
  assert.strictEqual(
    nativeParser.parse(currentSnapshot).toString(),
    nativeParser.parse(currentSource).toString(),
    "stale rejection leaves the intervening source intact for native parsing",
  );
  assert.strictEqual(
    nativeParser.parse(stale.snapshot).toString(),
    nativeParser.parse(staleSource).toString(),
    "stale rejection does not mutate the retained staged reader",
  );
}

main();
