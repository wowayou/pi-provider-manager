import assert from "node:assert/strict";
import test from "node:test";

import { TomlDocument, parseValue, serializeValue } from "../lib/toml-document.mjs";

// A file that exercises every construct the parser has to skip rather than
// understand. Nothing here is owned by this project, so every byte of it must
// survive an edit somewhere else in the file.
const AWKWARD = `# leading comment
model = "gpt-5.6-sol"
banner = """
[not_a_table]
still inside the string # not a comment
"""
literal = 'C:\\path\\with # hash'
matrix = [
  "a",  # trailing comment inside an array
  "b",
]

[tui]
notifications = true

[[mcp_servers]]
name = "first"

[[mcp_servers]]
name = "second"

["quoted.key"]
value = 1
`;

test("preserves a file it has no reason to touch", () => {
  assert.equal(TomlDocument.parse(AWKWARD).render(), AWKWARD);
});

test("does not mistake bracketed lines inside a multi-line string for headers", () => {
  const document = TomlDocument.parse(AWKWARD);
  assert.equal(document.section("not_a_table"), null);
  assert.equal(document.getTopLevel("banner").includes("[not_a_table]"), true);
});

test("does not mistake a hash inside a string for a comment", () => {
  const document = TomlDocument.parse(AWKWARD);
  assert.equal(document.getTopLevel("literal"), "C:\\path\\with # hash");
});

test("keeps a multi-line array as one entry", () => {
  const document = TomlDocument.parse(AWKWARD);
  assert.deepEqual(document.getTopLevel("matrix"), ["a", "b"]);
  document.setTopLevel("model", "kimi-k2");
  // Editing a different key must not disturb the array's own formatting.
  assert.equal(document.render().includes('  "a",  # trailing comment inside an array'), true);
});

test("treats an array of tables as distinct from a table", () => {
  const document = TomlDocument.parse(AWKWARD);
  assert.equal(document.section("mcp_servers"), null);
  assert.deepEqual(document.tableNames("mcp_servers"), []);
});

test("reads quoted header keys", () => {
  const document = TomlDocument.parse(AWKWARD);
  assert.deepEqual(document.tableKeys("quoted.key"), { value: 1 });
});

test("replaces an existing key in place and leaves the rest byte-identical", () => {
  const document = TomlDocument.parse(AWKWARD);
  document.setTopLevel("model", "gpt-5.6-codex");
  const rendered = document.render();
  assert.equal(rendered.includes('model = "gpt-5.6-codex"'), true);
  assert.equal(rendered.split("\n")[0], "# leading comment");
  assert.equal(rendered.includes("[tui]\nnotifications = true"), true);
});

test("inserts a new top-level key before the blank line that ends the preamble", () => {
  const document = TomlDocument.parse('model = "a"\n\n[tui]\nnotifications = true\n');
  document.setTopLevel("model_provider", "custom");
  assert.equal(
    document.render(),
    'model = "a"\nmodel_provider = "custom"\n\n[tui]\nnotifications = true\n',
  );
});

test("removes a table without disturbing its neighbours", () => {
  const source = '# top\n\n[model_providers.custom]\nname = "gone"\n\n[tui]\n# keep me\nnotifications = true\n';
  const document = TomlDocument.parse(source);
  assert.equal(document.removeTable("model_providers.custom"), true);
  assert.equal(document.render(), "# top\n\n[tui]\n# keep me\nnotifications = true\n");
});

test("removing a table does not touch a sibling table", () => {
  const source =
    '[model_providers.custom]\nname = "gone"\n\n[model_providers.myown]\n# hand written\nbase_url = "https://kept.example/v1"\n';
  const document = TomlDocument.parse(source);
  document.removeTable("model_providers.custom");
  assert.equal(
    document.render(),
    '[model_providers.myown]\n# hand written\nbase_url = "https://kept.example/v1"\n',
  );
});

test("creates a missing table separated by one blank line", () => {
  const document = TomlDocument.parse('model = "a"\n');
  document.upsertTable("model_providers.custom", { name: "Packy", wire_api: "responses" });
  assert.equal(
    document.render(),
    'model = "a"\n\n[model_providers.custom]\nname = "Packy"\nwire_api = "responses"\n',
  );
});

test("upsert leaves untouched keys and comments in an existing table alone", () => {
  const source = '[model_providers.custom]\n# why this exists\nname = "old"\nrequest_max_retries = 9\n';
  const document = TomlDocument.parse(source);
  document.upsertTable("model_providers.custom", { name: "new" });
  assert.equal(
    document.render(),
    '[model_providers.custom]\n# why this exists\nname = "new"\nrequest_max_retries = 9\n',
  );
});

test("upsert removes a key when its value is undefined", () => {
  const document = TomlDocument.parse('[model_providers.custom]\nname = "x"\nenv_key = "K"\n');
  document.upsertTable("model_providers.custom", { env_key: undefined });
  assert.equal(document.render(), '[model_providers.custom]\nname = "x"\n');
});

test("lists direct children only", () => {
  const document = TomlDocument.parse(
    "[model_providers.custom]\n[model_providers.other]\n[model_providers.custom.nested]\n[profiles.a]\n",
  );
  assert.deepEqual(document.tableNames("model_providers").sort(), ["custom", "other"]);
});

test("round-trips values it claims to understand", () => {
  const document = TomlDocument.parse("");
  document.setTopLevel("text", 'quote " and backslash \\');
  document.setTopLevel("number", 128000);
  document.setTopLevel("flag", false);
  document.setTopLevel("list", ["a", "b"]);
  document.setTopLevel("inline", { "X-Header": "v" });
  const reparsed = TomlDocument.parse(document.render());
  assert.equal(reparsed.getTopLevel("text"), 'quote " and backslash \\');
  assert.equal(reparsed.getTopLevel("number"), 128000);
  assert.equal(reparsed.getTopLevel("flag"), false);
  assert.deepEqual(reparsed.getTopLevel("list"), ["a", "b"]);
  assert.deepEqual(reparsed.getTopLevel("inline"), { "X-Header": "v" });
});

test("keeps non-ASCII text literal instead of escaping it", () => {
  const document = TomlDocument.parse("");
  document.setTopLevel("name", "国产网关");
  assert.equal(document.render(), 'name = "国产网关"\n');
});

test("refuses values that would need escapes it does not emit", () => {
  assert.throws(() => serializeValue("line\nbreak"), /控制字符/);
  assert.throws(() => serializeValue(Number.NaN), /非有限/);
  assert.throws(() => serializeValue(undefined), /无法序列化/);
});

test("reports an unrecognised value as undefined rather than guessing", () => {
  // Dates are valid TOML but outside this module's vocabulary. Returning
  // undefined keeps callers from writing back something they never read.
  assert.equal(parseValue("1979-05-27T07:32:00Z"), undefined);
  assert.equal(TomlDocument.parse("when = 1979-05-27\n").hasTopLevel("when"), true);
});

test("preserves CRLF files and files with no trailing newline", () => {
  assert.equal(TomlDocument.parse('a = 1\r\n\r\n[t]\r\nb = 2\r\n').render(), 'a = 1\r\n\r\n[t]\r\nb = 2\r\n');
  const noNewline = TomlDocument.parse('a = 1');
  noNewline.setTopLevel("b", 2);
  assert.equal(noNewline.render(), 'a = 1\nb = 2');
});

test("handles an empty file", () => {
  const document = TomlDocument.parse("");
  assert.equal(document.render(), "");
  document.setTopLevel("model", "x");
  assert.equal(document.render(), 'model = "x"\n');
});
