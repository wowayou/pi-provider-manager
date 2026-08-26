// Filesystem primitives shared by the Pi and Codex config writers.
//
// Every managed file is replaced through a validated temporary file so a
// partial write can never be observed, and callers snapshot the whole set
// beforehand so a failure part-way through a multi-file update can be undone.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A UTF-8 BOM is not JSON, and `JSON.parse` rejects it — but Notepad writes one
// on Windows, which this project supports, so a user who opens auth.json to look
// at it can make every read here fail. Pi itself became tolerant of this in
// 0.84.3 (auth-storage.js gained stripBom); without the same tolerance a file Pi
// reads is a file this manager refuses, and the error names a byte the reader
// cannot see. Only stripped on read: nothing here ever writes one back.
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function parseJsonBytes(filePath, bytes) {
  if (bytes === null) return {};
  const raw = stripBom(bytes.toString("utf8"));
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
  return parsed;
}

export function snapshot(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function readJson(filePath) {
  return parseJsonBytes(filePath, snapshot(filePath));
}

export function readText(filePath) {
  const bytes = snapshot(filePath);
  // Same reason as above. A prompt file does not fail to parse, but a leading
  // U+FEFF would travel into the prompt body and back out to the next save.
  return bytes === null ? "" : stripBom(bytes.toString("utf8"));
}

export function replaceFile(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (process.platform !== "win32" || !fs.existsSync(destination)) throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

// `validate` runs against the bytes actually on disk, so a serializer that
// produced something unreadable is caught before the real file is touched.
function writeAtomic(filePath, contents, validate) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (validate) validate(fs.readFileSync(temporaryPath, "utf8"));
    replaceFile(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

export function writeJsonAtomic(filePath, value) {
  writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, (written) => JSON.parse(written));
}

export function writeTextAtomic(filePath, text, validate) {
  writeAtomic(filePath, text, validate);
}

export function restore(filePath, bytes) {
  if (bytes === null) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return;
  }
  const temp = `${filePath}.rollback.${process.pid}`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  replaceFile(temp, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}
