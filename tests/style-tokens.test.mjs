import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Dark mode is the same design at a second set of token values (AGENTS.md), so
// a colour that bypasses the tokens, or a token nobody defined, breaks one theme
// without any visible error. These checks read the stylesheet as text; they do
// not replace the browser contrast audit, which measures rendered colours.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

// Every declaration with the chain of selectors / at-rules it sits in.
function declarations(text) {
  const out = [];
  const stack = [];
  let buffer = "";
  for (const char of text) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      if (buffer.trim()) out.push({ scope: stack.join(" > "), text: buffer.trim() });
      stack.pop();
      buffer = "";
    } else if (char === ";") {
      if (buffer.trim()) out.push({ scope: stack.join(" > "), text: buffer.trim() });
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return out;
}

function tokenBlock(selectorPattern) {
  const match = css.match(selectorPattern);
  assert.ok(match, `token block ${selectorPattern} not found`);
  return new Set([...match[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((entry) => entry[1]));
}

const NAMED_COLOURS = /\b(white|black|red|green|blue|orange|gr[ae]y|yellow|silver|purple|pink|brown|navy|teal)\b/i;

test("rules take colours from tokens, never from literal hex or named colours", () => {
  const all = declarations(css);
  assert.ok(all.length > 500, `expected the real stylesheet, parsed ${all.length} declarations`);
  const offenders = all
    .filter(({ text }) => !text.startsWith("--"))
    .filter(({ text }) => {
      const value = text.slice(text.indexOf(":") + 1).replace(/var\([^)]*\)/g, "");
      // rgba()/hsla() stay allowed: the shadows and the toast's translucent
      // whites are alpha stencils that read correctly on both themes.
      return /#[0-9a-f]{3,8}\b/i.test(value) || NAMED_COLOURS.test(value);
    })
    .map(({ scope, text }) => `${scope} :: ${text}`);
  assert.deepEqual(offenders, [], "add or reuse a semantic token instead");
});

test("every custom property the stylesheet reads is defined", () => {
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((entry) => entry[1]));
  // Set from JSX as an inline style, and read with a fallback.
  const setInline = new Set(["--editor-rows"]);
  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((entry) => entry[1]));
  const missing = [...used].filter((name) => !defined.has(name) && !setInline.has(name));
  assert.deepEqual(missing, [], "an undefined token makes the declaration invalid and silently drops it");
});

test("the dark theme only redefines tokens the light :root already declares", () => {
  const light = tokenBlock(/(?:^|\n):root\s*\{([^}]*)\}/);
  const dark = tokenBlock(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
  assert.ok(light.size > 50 && dark.size > 50, `light ${light.size}, dark ${dark.size}`);
  assert.deepEqual([...dark].filter((name) => !light.has(name)), []);
});

test("font sizes come from the type scale", () => {
  const scale = tokenBlock(/(?:^|\n):root\s*\{([^}]*)\}/);
  const steps = [...scale].filter((name) => name.startsWith("--text-"));
  assert.ok(steps.length >= 6, `expected the --text-* scale, found ${steps.join(", ")}`);
  // A px size outside the scale is how thirteen ad-hoc sizes accumulated. Relative
  // sizes (`.94em` on the monospace face) and `inherit` stay allowed.
  const offenders = declarations(css)
    .filter(({ text }) => /^font(-size)?\s*:/.test(text))
    .filter(({ text }) => /\d(\.\d+)?px/.test(text.replace(/var\([^)]*\)/g, "")))
    .map(({ scope, text }) => `${scope} :: ${text}`);
  assert.deepEqual(offenders, [], "use a --text-* token");
});
