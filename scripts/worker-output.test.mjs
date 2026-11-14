import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithOutputFiles, readOutputTail, readStartedThreadId } from "./worker-output.mjs";

test("output above the former 50 MiB ceiling survives a tiny pipe buffer", () => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-output-test-"));
  const out = join(dir, "out"), err = join(dir, "err");
  const result = runWithOutputFiles(process.execPath, ["-e", `
    const fs = require('node:fs');
    const input = fs.readFileSync(0, 'utf8');
    for (let n=0;n<55;n++) fs.writeSync(1, Buffer.alloc(1024*1024, 120));
    fs.writeSync(1, '\\n'+JSON.stringify({type:'thread.started',thread_id:input})+'\\n');
    fs.writeSync(2, 'expected diagnostic'); process.exitCode=7;
  `], { input: "fixture-thread", encoding: "utf8", maxBuffer: 1024, windowsHide: true }, out, err);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7);
  assert.ok(statSync(out).size > 50 * 1024 * 1024);
  assert.equal(readOutputTail(err), "expected diagnostic");
  assert.equal(readStartedThreadId(out), "fixture-thread");
  assert.equal(readOutputTail(out, 64).length, 64);
});
test("missing and unterminated thread metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "botcow-metadata-test-"));
  const path = join(dir, "events");
  writeFileSync(path, 'diagnostic\n{"type":"thread.started","thread_id":"id"}');
  assert.equal(readStartedThreadId(path), "id");
  writeFileSync(path, 'not json\n');
  assert.equal(readStartedThreadId(path), null);
});
