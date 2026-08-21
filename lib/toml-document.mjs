// A deliberately small TOML document model.
//
// It is not a TOML implementation. It knows just enough to read and edit the
// handful of keys and tables this project owns inside Codex's config.toml,
// while leaving every other byte of the file exactly as the user wrote it —
// comments, ordering, blank lines, and constructs we do not understand.
//
// The parser's real job is therefore to *skip* things safely: a `[foo]` inside
// a multi-line string is not a table header, and a `#` inside a string is not
// a comment. Anything it cannot classify becomes a raw line copied through
// untouched.

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function skipBasicString(line, start) {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === '"') return index + 1;
    index += 1;
  }
  return line.length;
}

function skipLiteralString(line, start) {
  const end = line.indexOf("'", start + 1);
  return end === -1 ? line.length : end + 1;
}

// Advances the multi-line scan state across one line. `depth` tracks unclosed
// `[`/`{`, `inTriple` tracks an open """ or ''' block. While either is active
// the next line is a continuation, not a new statement.
function advance(state, line, from = 0) {
  let index = from;
  while (index < line.length) {
    if (state.inTriple) {
      if (line.startsWith(state.inTriple, index)) {
        state.inTriple = null;
        index += 3;
        continue;
      }
      index += 1;
      continue;
    }
    const char = line[index];
    if (char === "#") return state;
    if (line.startsWith('"""', index)) {
      state.inTriple = '"""';
      index += 3;
      continue;
    }
    if (line.startsWith("'''", index)) {
      state.inTriple = "'''";
      index += 3;
      continue;
    }
    if (char === '"') {
      index = skipBasicString(line, index);
      continue;
    }
    if (char === "'") {
      index = skipLiteralString(line, index);
      continue;
    }
    if (char === "[" || char === "{") state.depth += 1;
    else if (char === "]" || char === "}") state.depth -= 1;
    index += 1;
  }
  return state;
}

function unescapeBasic(raw) {
  let result = "";
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "\\") {
      result += raw[index];
      continue;
    }
    const next = raw[index + 1];
    index += 1;
    if (next === "n") result += "\n";
    else if (next === "t") result += "\t";
    else if (next === "r") result += "\r";
    else if (next === "\\") result += "\\";
    else if (next === '"') result += '"';
    else if (next === "b") result += "\b";
    else if (next === "f") result += "\f";
    else if (next === "u") {
      result += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16));
      index += 4;
    } else if (next === "U") {
      result += String.fromCodePoint(Number.parseInt(raw.slice(index + 1, index + 9), 16));
      index += 8;
    } else {
      result += next;
    }
  }
  return result;
}

// Reads one key at `index`, which may be bare, quoted, or dotted. Returns the
// normalized dotted key and the index just past it.
function readKey(text, index) {
  const parts = [];
  let cursor = index;
  for (;;) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] === '"') {
      const end = skipBasicString(text, cursor);
      parts.push(unescapeBasic(text.slice(cursor + 1, end - 1)));
      cursor = end;
    } else if (text[cursor] === "'") {
      const end = skipLiteralString(text, cursor);
      parts.push(text.slice(cursor + 1, end - 1));
      cursor = end;
    } else {
      const start = cursor;
      while (cursor < text.length && /[A-Za-z0-9_-]/.test(text[cursor])) cursor += 1;
      if (cursor === start) return null;
      parts.push(text.slice(start, cursor));
    }
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== ".") break;
    cursor += 1;
  }
  return { key: parts.join("."), parts, end: cursor };
}

function parseHeader(line) {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("[")) return null;
  const isArray = trimmed.startsWith("[[");
  const offset = line.length - trimmed.length + (isArray ? 2 : 1);
  const read = readKey(line, offset);
  if (!read) return null;
  const rest = line.slice(read.end).trimStart();
  if (!rest.startsWith(isArray ? "]]" : "]")) return null;
  return { name: read.key, parts: read.parts, isArray };
}

function splitKeyValue(line) {
  const read = readKey(line, 0);
  if (!read) return null;
  if (line[read.end] !== "=") return null;
  return { key: read.key, valueStart: read.end + 1 };
}

// Strips `#` comments that sit outside any string. A comment ends at its own
// line, not at the end of the text: a multi-line array may carry one on every
// element, and truncating there would swallow the rest of the value.
function stripComments(text) {
  const state = { inTriple: null };
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (state.inTriple) {
      if (text.startsWith(state.inTriple, index)) {
        result += state.inTriple;
        state.inTriple = null;
        index += 3;
        continue;
      }
      result += text[index];
      index += 1;
      continue;
    }
    const char = text[index];
    if (char === "#") {
      const lineEnd = text.indexOf("\n", index);
      if (lineEnd === -1) break;
      index = lineEnd;
      continue;
    }
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      state.inTriple = text.slice(index, index + 3);
      result += state.inTriple;
      index += 3;
      continue;
    }
    if (char === '"') {
      const end = skipBasicString(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "'") {
      const end = skipLiteralString(text, index);
      result += text.slice(index, end);
      index = end;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function splitTopLevel(text) {
  const items = [];
  const state = { depth: 0, inTriple: null };
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (state.inTriple) {
      if (text.startsWith(state.inTriple, index)) {
        state.inTriple = null;
        index += 3;
      } else index += 1;
      continue;
    }
    const char = text[index];
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      state.inTriple = text.slice(index, index + 3);
      index += 3;
      continue;
    }
    if (char === '"') {
      index = skipBasicString(text, index);
      continue;
    }
    if (char === "'") {
      index = skipLiteralString(text, index);
      continue;
    }
    if (char === "[" || char === "{") {
      state.depth += 1;
      index += 1;
      continue;
    }
    if (char === "]" || char === "}") {
      state.depth -= 1;
      index += 1;
      continue;
    }
    if (char === "," && state.depth === 0) {
      items.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  items.push(text.slice(start));
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

// Returns the JavaScript value for a TOML value, or undefined when the shape is
// outside this module's vocabulary. Undefined means "we do not understand it",
// never "it is absent" — callers must not write such a key back.
export function parseValue(raw) {
  const text = stripComments(raw).trim();
  if (text === "") return undefined;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text.startsWith('"""') && text.endsWith('"""') && text.length >= 6) {
    return unescapeBasic(text.slice(3, -3).replace(/^\r?\n/, ""));
  }
  if (text.startsWith("'''") && text.endsWith("'''") && text.length >= 6) {
    return text.slice(3, -3).replace(/^\r?\n/, "");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return unescapeBasic(text.slice(1, -1));
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitTopLevel(text.slice(1, -1)).map((item) => parseValue(item));
  }
  if (text.startsWith("{") && text.endsWith("}")) {
    const result = {};
    for (const item of splitTopLevel(text.slice(1, -1))) {
      const pair = splitKeyValue(item);
      if (!pair) continue;
      result[pair.key] = parseValue(item.slice(pair.valueStart));
    }
    return result;
  }
  if (/^[+-]?[0-9_]+$/.test(text)) return Number.parseInt(text.replace(/_/g, ""), 10);
  if (/^[+-]?[0-9_]*\.[0-9_]+([eE][+-]?[0-9]+)?$/.test(text)) {
    return Number.parseFloat(text.replace(/_/g, ""));
  }
  return undefined;
}

export function serializeKey(key) {
  if (CONTROL_CHARS.test(key)) throw new Error("配置键不能包含控制字符。");
  return BARE_KEY.test(key) ? key : `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function serializeValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOML 不支持非有限数值。");
    return String(value);
  }
  if (typeof value === "string") {
    // Control characters would need \uXXXX escapes and never appear in the
    // values this project writes; refusing is safer than emitting something
    // that only looks right.
    if (CONTROL_CHARS.test(value)) throw new Error("配置值不能包含控制字符。");
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (Array.isArray(value)) return `[${value.map((item) => serializeValue(item)).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const pairs = Object.entries(value).map(([key, item]) => `${serializeKey(key)} = ${serializeValue(item)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  throw new Error("无法序列化该配置值。");
}

export function serializeHeader(parts) {
  return parts.map((part) => serializeKey(part)).join(".");
}

function isBlank(line) {
  return line.trim() === "";
}

class Section {
  constructor(name, parts, isArray, headerLine) {
    this.name = name;
    this.parts = parts;
    this.isArray = isArray;
    this.headerLine = headerLine;
    this.entries = [];
  }

  findKey(key) {
    return this.entries.find((entry) => entry.kind === "kv" && entry.key === key) || null;
  }

  valueOf(entry) {
    return parseValue(entry.lines.join("\n").slice(entry.valueStart));
  }

  keys() {
    const result = {};
    for (const entry of this.entries) {
      if (entry.kind !== "kv") continue;
      const value = this.valueOf(entry);
      if (value !== undefined) result[entry.key] = value;
    }
    return result;
  }

  set(key, value) {
    const line = `${serializeKey(key)} = ${serializeValue(value)}`;
    const valueStart = line.indexOf("=") + 1;
    const existing = this.findKey(key);
    if (existing) {
      existing.lines = [line];
      existing.valueStart = valueStart;
      return;
    }
    // Insert before the blank lines that separate this section from the next
    // one, so a new key never lands after the gap.
    let at = this.entries.length;
    while (at > 0) {
      const previous = this.entries[at - 1];
      if (previous.kind === "raw" && previous.lines.every(isBlank)) at -= 1;
      else break;
    }
    this.entries.splice(at, 0, { kind: "kv", key, lines: [line], valueStart });
  }

  remove(key) {
    const index = this.entries.findIndex((entry) => entry.kind === "kv" && entry.key === key);
    if (index === -1) return false;
    this.entries.splice(index, 1);
    return true;
  }

  lines() {
    const result = this.headerLine === null ? [] : [this.headerLine];
    for (const entry of this.entries) result.push(...entry.lines);
    return result;
  }
}

export class TomlDocument {
  constructor(sections, eol, trailingNewline) {
    this.sections = sections;
    this.eol = eol;
    this.trailingNewline = trailingNewline;
  }

  static parse(text) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = text === "" || text.endsWith("\n");
    const body = trailingNewline ? text.replace(/\r?\n$/, "") : text;
    const lines = body === "" ? [] : body.split(/\r?\n/);

    const preamble = new Section(null, [], false, null);
    const sections = [preamble];
    let current = preamble;
    const state = { depth: 0, inTriple: null };
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      const header = parseHeader(line);
      if (header) {
        current = new Section(header.name, header.parts, header.isArray, line);
        sections.push(current);
        index += 1;
        continue;
      }
      const pair = splitKeyValue(line);
      if (pair) {
        state.depth = 0;
        state.inTriple = null;
        advance(state, line, pair.valueStart);
        const collected = [line];
        while ((state.depth > 0 || state.inTriple) && index + 1 < lines.length) {
          index += 1;
          collected.push(lines[index]);
          advance(state, lines[index]);
        }
        current.entries.push({ kind: "kv", key: pair.key, lines: collected, valueStart: pair.valueStart });
        index += 1;
        continue;
      }
      current.entries.push({ kind: "raw", lines: [line] });
      index += 1;
    }
    return new TomlDocument(sections, eol, trailingNewline);
  }

  render() {
    const lines = [];
    for (const section of this.sections) lines.push(...section.lines());
    const text = lines.join(this.eol);
    if (!this.trailingNewline) return text;
    return text === "" ? "" : `${text}${this.eol}`;
  }

  section(name) {
    return this.sections.find((item) => item.name === name && !item.isArray) || null;
  }

  getTopLevel(key) {
    const entry = this.sections[0].findKey(key);
    return entry ? this.sections[0].valueOf(entry) : undefined;
  }

  hasTopLevel(key) {
    return this.sections[0].findKey(key) !== null;
  }

  setTopLevel(key, value) {
    const preamble = this.sections[0];
    preamble.set(key, value);
    // A top-level key has to precede every table, so a new one lands at the end
    // of the preamble. Without a blank line it reads as part of whatever table
    // header follows it.
    if (this.sections.length > 1) {
      const lines = preamble.lines();
      if (lines.length > 0 && !isBlank(lines[lines.length - 1])) {
        preamble.entries.push({ kind: "raw", lines: [""] });
      }
    }
  }

  removeTopLevel(key) {
    return this.sections[0].remove(key);
  }

  tableKeys(name) {
    const section = this.section(name);
    return section ? section.keys() : null;
  }

  // Direct children of `prefix`, e.g. tableNames("model_providers") for every
  // [model_providers.<id>] in the file.
  tableNames(prefix) {
    const scope = `${prefix}.`;
    return this.sections
      .filter((section) => section.name !== null && !section.isArray && section.name.startsWith(scope))
      .map((section) => section.name.slice(scope.length))
      .filter((rest) => rest !== "" && !rest.includes("."));
  }

  // Creates the table when missing and writes the given keys. Keys already in
  // the table but absent from `keys` are left alone; call removeTable first
  // when the caller means to replace the table wholesale.
  upsertTable(name, keys) {
    let section = this.section(name);
    if (!section) {
      const parts = name.split(".");
      section = new Section(name, parts, false, `[${serializeHeader(parts)}]`);
      const last = this.sections[this.sections.length - 1];
      const lastLines = last.lines();
      if (lastLines.length > 0 && !isBlank(lastLines[lastLines.length - 1])) {
        last.entries.push({ kind: "raw", lines: [""] });
      }
      this.sections.push(section);
    }
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) section.remove(key);
      else section.set(key, value);
    }
    return section;
  }

  // Replaces a table's contents wholesale while keeping it where it already
  // sits in the file. Switching providers rewrites the same table over and
  // over, and appending it to the end each time would shuffle a file the user
  // reads by hand.
  replaceTable(name, keys) {
    const index = this.sections.findIndex((section) => section.name === name && !section.isArray);
    if (index === -1) return this.upsertTable(name, keys);
    const previous = this.sections[index];
    const parts = name.split(".");
    const replacement = new Section(name, parts, false, previous.headerLine);
    for (const [key, value] of Object.entries(keys)) {
      if (value !== undefined) replacement.set(key, value);
    }
    // The blank lines that separated the old table from the next one are part
    // of the file's layout, not of the table's contents.
    const trailing = [];
    for (let at = previous.entries.length - 1; at >= 0; at -= 1) {
      const entry = previous.entries[at];
      if (entry.kind === "raw" && entry.lines.every(isBlank)) trailing.unshift(entry);
      else break;
    }
    replacement.entries.push(...trailing);
    this.sections.splice(index, 1, replacement);
    return replacement;
  }

  removeTable(name) {
    const index = this.sections.findIndex((section) => section.name === name && !section.isArray);
    if (index === -1) return false;
    const section = this.sections[index];
    // Blank lines trailing the removed table belong to the gap it created, so
    // they go with it. A blank line *before* the header belongs to whatever
    // came before and is left in place.
    while (section.entries.length > 0) {
      const last = section.entries[section.entries.length - 1];
      if (last.kind === "raw" && last.lines.every(isBlank)) section.entries.pop();
      else break;
    }
    this.sections.splice(index, 1);
    return true;
  }
}
