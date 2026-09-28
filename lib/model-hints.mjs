// Per-gateway learned capacity hints: what the user last saved as a model's
// contextWindow / maxTokens, remembered by (provider id, model id) so re-adding
// that model on the same gateway — after a delete, or while rebuilding a list —
// pre-fills the numbers they already chose instead of the family guess.
//
// Keyed by gateway *and* ID on purpose: the same model ID behind two relays can
// have two different real ceilings, so a value learned on one gateway must not
// leak onto another. This is manager-private state, not a Pi file: it lives in a
// 0600 file beside the others, is never part of the config revision (like the
// bridge runtime record), and a failure to write it must never fail a save.

import { isObject, parseJsonBytes, snapshot, writeJsonAtomic } from "./atomic-files.mjs";

// Mirrors ui-kit's MAX_TOKENS: a generous ceiling that still rejects a typo.
const MAX_CAPACITY = 100_000_000;
// Bounds the file so a churn of drafts cannot grow it without limit. When over,
// the oldest entries by last-seen time are dropped.
const MAX_ENTRIES = 1000;

function validCapacity(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_CAPACITY;
}

// Never throws: an unreadable or malformed hints file is treated as empty, the
// same tolerance the rest of the read path has, because a corrupt convenience
// cache must not take down a state read.
export function readModelHints(filePath) {
  let parsed;
  try {
    parsed = parseJsonBytes(filePath, snapshot(filePath));
  } catch {
    return {};
  }
  const stored = isObject(parsed.hints) ? parsed.hints : {};
  const providers = [];
  for (const [providerId, models] of Object.entries(stored)) {
    if (!isObject(models)) continue;
    const entries = [];
    for (const [modelId, entry] of Object.entries(models)) {
      if (!isObject(entry)) continue;
      if (!validCapacity(entry.contextWindow) || !validCapacity(entry.maxTokens) || entry.maxTokens >= entry.contextWindow) continue;
      entries.push([modelId, {
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
        at: Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : 0,
      }]);
    }
    if (entries.length) providers.push([providerId, Object.fromEntries(entries)]);
  }
  // IDs are data, including constructor and __proto__. fromEntries creates own
  // properties without consulting or mutating the Object prototype chain.
  return Object.fromEntries(providers);
}

// The map the client consults when seeding a new row: provider → model →
// {contextWindow, maxTokens}. The last-seen timestamp is internal, so it is
// dropped here.
export function publicModelHints(filePath) {
  const hints = readModelHints(filePath);
  return Object.fromEntries(Object.entries(hints).map(([providerId, models]) => [
    providerId,
    Object.fromEntries(Object.entries(models).map(([modelId, entry]) => [
      modelId, { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens },
    ])),
  ]));
}

// Records the capacities a save wrote for one provider's models, merged onto
// whatever was already learned. Callers pass the normalized model list; only
// valid numeric pairs are stored. Returns nothing and swallows write errors: the
// provider save has already succeeded on disk, and the hint is a convenience.
export function recordModelHints(filePath, providerId, models) {
  if (typeof providerId !== "string" || !providerId) return;
  const list = Array.isArray(models) ? models : [];
  const entries = list.filter((model) =>
    isObject(model) && typeof model.id === "string" && model.id
    && validCapacity(model.contextWindow) && validCapacity(model.maxTokens)
    && model.maxTokens < model.contextWindow);
  if (entries.length === 0) return;
  const previous = readModelHints(filePath);
  const now = Date.now();
  const hints = {
    ...previous,
    [providerId]: {
      ...(Object.hasOwn(previous, providerId) ? previous[providerId] : {}),
      ...Object.fromEntries(entries.map((model) => [model.id, {
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, at: now,
      }])),
    },
  };
  prune(hints);
  try {
    writeJsonAtomic(filePath, { version: 1, hints });
  } catch {
    // A convenience cache that cannot be written is simply not written.
  }
}

// Drops the oldest entries once the total exceeds the cap, and removes providers
// left empty. Counts across all providers so one gateway's long catalogue cannot
// crowd out another's.
function prune(hints) {
  const flat = [];
  for (const [providerId, models] of Object.entries(hints)) {
    for (const [modelId, entry] of Object.entries(models)) flat.push({ providerId, modelId, at: entry.at || 0 });
  }
  if (flat.length <= MAX_ENTRIES) return;
  flat.sort((a, b) => a.at - b.at);
  for (const { providerId, modelId } of flat.slice(0, flat.length - MAX_ENTRIES)) {
    delete hints[providerId][modelId];
    if (Object.keys(hints[providerId]).length === 0) delete hints[providerId];
  }
}
