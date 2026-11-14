import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function runWithOutputFiles(executable, args, options, stdoutPath, stderrPath) {
  const stdoutFd = openSync(stdoutPath, "wx");
  let stderrFd;
  try {
    stderrFd = openSync(stderrPath, "wx");
    return spawnSync(executable, args, {
      ...options, stdio: ["pipe", stdoutFd, stderrFd],
    });
  } finally {
    closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
}

export function readOutputTail(path, limit = 4000) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - limit));
    return buffer.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}

// Scan NDJSON without retaining large tool-output events in memory.
export function readStartedThreadId(path) {
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let line = "", oversized = false;
  try {
    let count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (const char of buffer.subarray(0, count).toString("utf8")) {
        if (char === "\n") {
          if (!oversized) {
            try {
              const event = JSON.parse(line);
              if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
            } catch { /* Non-JSON diagnostics are not thread metadata. */ }
          }
          line = ""; oversized = false;
        } else if (!oversized) {
          line += char;
          if (line.length > 16384) { line = ""; oversized = true; }
        }
      }
    }
    if (!oversized && line.trim()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
      } catch { /* Incomplete final record. */ }
    }
    return null;
  } finally { closeSync(fd); }
}
