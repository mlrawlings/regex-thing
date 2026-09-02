const regexgen = require('regexgen');
const startOrEnd = /\^|\$/;

module.exports = function getRegex(includeList, excludeList) {
  let bad;
  if (bad = includeList.find(i => excludeList.includes(i))) {
    throw new Error(`"${bad}" is included in both the include and exclude lists`);
  } else if (bad = includeList.concat(excludeList).find(w => startOrEnd.test(w))) {
    throw new Error(`"${bad}" contains ^ or $ which is not supported`);
  }

  const { candidates, allFeatures } = generateFeatures(includeList, excludeList);
  const n = includeList.length;

  // Run multiple beam configs through the full post-processing pipeline.
  // Comparing only beam output (pre-pipeline) picks the wrong starting point —
  // different beam configs can diverge significantly after local search.
  const beamConfigs = [
    { K: 80, expand: 8, bonus: 1.0 },
    { K: 50, expand: 5, bonus: 1.0 },
    { K: 80, expand: 8, bonus: 1.15 },
    { K: 80, expand: 8, bonus: 1.3 },
    { K: 80, expand: 8, bonus: 2.0 },  // high bonus strongly clusters features by prefix
  ];

  let bestSelected = null;
  let bestLen = Infinity;
  for (const { K, expand, bonus } of beamConfigs) {
    const seed = runBeam(candidates, allFeatures, n, K, expand, bonus);
    if (!seed) continue;
    const result = runPipeline(seed, allFeatures, n);
    const len = measureLen(result);
    if (len < bestLen) { bestLen = len; bestSelected = result; }
  }

  // Exclusion sweep: for the top high-coverage candidates (ones the beam always
  // picks greedily), try excluding each from candidates to force alternative paths.
  // A greedily-efficient feature can prevent finding better globally-compressed sets.
  const highEff = candidates
    .filter(c => c.covers.size >= 3 && c.pattern.length <= 3)
    .sort((a, b) => (b.covers.size / b.pattern.length) - (a.covers.size / a.pattern.length))
    .slice(0, 5);  // Top-5 to catch rank-4 features that crowd out better solutions
  for (const exclude of highEff) {
    const excl = candidates.filter(c => c !== exclude);
    const seed = runBeam(excl, allFeatures, n, 60, 6, 1.0);
    if (!seed) continue;
    const result = runPipeline(seed, allFeatures, n);
    const len = measureLen(result);
    if (len < bestLen) { bestLen = len; bestSelected = result; }
  }

  // Combined exclusion: simultaneously remove ALL high-efficiency features (score ≥ 2.0)
  // to force the beam toward distributed coverage. The pipeline then adds efficient
  // features back only if they genuinely shorten the regex, preventing local optima
  // where two features (e.g. 'ea'+'ge') jointly crowd out a better distributed solution.
  const veryHighEff = highEff.filter(c => (c.covers.size / c.pattern.length) >= 2.0);
  if (veryHighEff.length >= 2) {
    const vSet = new Set(veryHighEff);
    const excl = candidates.filter(c => !vSet.has(c));
    const seed = runBeam(excl, allFeatures, n, 60, 6, 1.0);
    if (seed) {
      const result = runPipeline(seed, allFeatures, n);
      const len = measureLen(result);
      if (len < bestLen) { bestLen = len; bestSelected = result; }
    }
  }

  const regex = optimizeRegex(unescapeStartEnd(regexgen(bestSelected)));
  sanityCheck(regex, includeList, excludeList);
  return regex;
};

function runPipeline(selected, allFeatures, n) {
  selected = swapSearch(selected, allFeatures, n);
  selected = addAndPrune(selected, allFeatures, n);
  selected = swapSearch(selected, allFeatures, n);
  selected = prefixClusterSearch(selected, allFeatures, n);
  selected = addAndPrune(selected, allFeatures, n);
  selected = saturationSearch(selected, allFeatures, n);
  selected = addAndPrune(selected, allFeatures, n);
  selected = tightenPrune(selected, allFeatures, n);
  // addAndTighten: add short features then tightenPrune — can restructure
  // clusters that addAndPrune misses (e.g. add 'ai', drop 'ge' + 'ue')
  selected = addAndTighten(selected, allFeatures, n);
  return selected;
}

// ─── Add-and-tighten ──────────────────────────────────────────────────────
// Like addAndPrune but uses tightenPrune instead of pruneRedundant.
// Can discover restructurings where adding feature X enables tightenPrune
// to remove features that pruneRedundant would miss (wrong removal order).

function addAndTighten(selected, allFeatures, n) {
  const shortFeats = allFeatures
    .filter(f => f.pattern.length <= 3)
    .sort((a, b) => a.pattern.length - b.pattern.length);

  let current = selected;
  let currentLen = measureLen(current);
  let improved = true;

  while (improved) {
    improved = false;
    for (const f of shortFeats) {
      if (current.includes(f.pattern)) continue;
      const test = tightenPrune([...current, f.pattern], allFeatures, n);
      const len = measureLen(test);
      if (len < currentLen) {
        current = test;
        currentLen = len;
        improved = true;
      }
    }
  }
  return current;
}

// ─── Beam search ───────────────────────────────────────────────────────────
// Explores K partial solutions simultaneously.
// Complete solutions are measured with actual regexgen at the end.

function runBeam(candidates, allFeatures, n, K, expand, prefixBonus) {
  let beam = [{ selected: [], covered: new Set(), roughCost: 0 }];
  const complete = [];

  for (let round = 0; round < n + 10 && beam.length > 0; round++) {
    const nextPartial = [];

    for (const state of beam) {
      const selectedPrefixes = prefixBonus > 1 ? new Set(state.selected.map(p => p[0])) : null;
      const scored = [];
      for (const f of candidates) {
        const nc = countNew(f.covers, state.covered);
        if (nc === 0) continue;
        const bonus = selectedPrefixes && selectedPrefixes.has(f.pattern[0]) ? prefixBonus : 1.0;
        scored.push({ f, nc, score: (nc / f.pattern.length) * bonus });
      }
      if (scored.length === 0) continue;
      scored.sort((a, b) => b.score - a.score || a.f.pattern.length - b.f.pattern.length);

      for (const { f } of scored.slice(0, expand)) {
        const newCovered = new Set(state.covered);
        f.covers.forEach(wi => newCovered.add(wi));
        const sep = state.selected.length > 0 ? 1 : 0;
        const newCost = state.roughCost + f.pattern.length + sep;
        const newState = {
          selected: [...state.selected, f.pattern],
          covered: newCovered,
          roughCost: newCost,
        };
        if (newCovered.size === n) {
          complete.push(newState);
        } else {
          nextPartial.push(newState);
        }
      }
    }

    nextPartial.sort((a, b) => a.roughCost - b.roughCost);
    beam = nextPartial.slice(0, K);
    if (complete.length >= K * 4) break;
  }

  if (complete.length === 0) return null;

  // Adjust roughCost by subtracting a bonus for same-prefix feature pairs.
  // Same-prefix features compress well in regexgen (char classes, x(A|B) groups),
  // but roughCost can't see this — leading the beam to prefer {ge,ea} over {ai,cl,rn}
  // even when the clustered set produces a shorter final regex.
  function adjustedCost(s) {
    const prefixCounts = {};
    for (const pat of s.selected) {
      const p = pat[0];
      prefixCounts[p] = (prefixCounts[p] || 0) + 1;
    }
    let pairs = 0;
    for (const c of Object.values(prefixCounts)) pairs += c * (c - 1) / 2;
    return s.roughCost - pairs;
  }

  complete.sort((a, b) => adjustedCost(a) - adjustedCost(b));
  const toMeasure = complete.slice(0, K * 2);
  let best = null;
  let bestLen = Infinity;
  for (const s of toMeasure) {
    const pruned = pruneRedundant(s.selected, allFeatures, n);
    const len = measureLen(pruned);
    if (len < bestLen) { bestLen = len; best = pruned; }
  }
  return best;
}

// ─── Swap local search ─────────────────────────────────────────────────────
// For each selected feature, try replacing it with any valid alternative that
// covers the "critical" words (words only that feature covers). Prefer shorter
// alternatives; allow same-length alternatives that may compress better.

function swapSearch(selected, allFeatures, n) {
  const featMap = buildFeatMap(allFeatures);
  let improved = true;

  while (improved) {
    improved = false;
    const wordCoveredBy = buildWordCoveredBy(selected, allFeatures, n);

    for (let fi = 0; fi < selected.length; fi++) {
      const currentFeat = featMap.get(selected[fi]);
      if (!currentFeat) continue;

      // Find words covered only by this feature
      const criticalWords = new Set();
      for (const wi of currentFeat.covers) {
        let otherCount = 0;
        for (const fj of wordCoveredBy[wi]) {
          if (fj !== fi) otherCount++;
        }
        if (otherCount === 0) criticalWords.add(wi);
      }

      // Alternatives: cover all critical words, length ≤ current + 1
      const maxLen = currentFeat.pattern.length + 1;
      const alts = allFeatures.filter(alt =>
        alt.pattern !== selected[fi] &&
        alt.pattern.length <= maxLen &&
        [...criticalWords].every(wi => alt.covers.has(wi))
      );
      if (alts.length === 0) continue;

      const currentLen = measureLen(selected);
      let bestAlt = null;
      let bestLen = currentLen;

      for (const alt of alts) {
        const test = [...selected];
        test[fi] = alt.pattern;
        const len = measureLen(test);
        if (len < bestLen) { bestLen = len; bestAlt = alt; }
      }

      if (bestAlt) {
        selected = [...selected];
        selected[fi] = bestAlt.pattern;
        improved = true;
        break;
      }
    }
  }
  return selected;
}

// ─── Add-and-prune local search ────────────────────────────────────────────
// Try adding each short valid feature (even if it covers already-covered words).
// Regexgen may compress the combined set better, and redundant features are
// then pruned away. This can achieve complex multi-feature replacements.

function addAndPrune(selected, allFeatures, n) {
  const shortFeatures = allFeatures
    .filter(f => f.pattern.length <= 4 && !selected.includes(f.pattern))
    .sort((a, b) => a.pattern.length - b.pattern.length);

  let current = selected;
  let currentLen = measureLen(current);
  let improved = true;

  while (improved) {
    improved = false;
    for (const f of shortFeatures) {
      if (current.includes(f.pattern)) continue;
      const test = pruneRedundant([...current, f.pattern], allFeatures, n);
      const len = measureLen(test);
      if (len < currentLen) {
        current = test;
        currentLen = len;
        improved = true;
      }
    }
  }
  return current;
}

// ─── Prefix cluster search ─────────────────────────────────────────────────
// For each first-character prefix (a-z, ^, -, etc.), replace the current
// set of same-prefix features with the greedy-optimal covering for the words
// that need that prefix.  Same-prefix features compress well in regexgen
// (char classes, `a(te|ll|ch|i)` style groups, `ls?$` etc.), so finding the
// right cluster per prefix can significantly reduce regex length.

function prefixClusterSearch(selected, allFeatures, n) {
  const prefixes = [...new Set(allFeatures.map(f => f.pattern[0]))];
  let current = [...selected];
  let currentLen = measureLen(current);
  let improved = true;

  while (improved) {
    improved = false;
    for (const prefix of prefixes) {
      const others = current.filter(p => p[0] !== prefix);
      const currentPFeats = current.filter(p => p[0] === prefix);
      if (currentPFeats.length === 0) continue;

      // Coverage from non-prefix features
      const otherCoverage = new Set();
      for (const pat of others) {
        const f = allFeatures.find(f => f.pattern === pat);
        if (f) f.covers.forEach(wi => otherCoverage.add(wi));
      }

      // Words that require prefix-P features
      const needCoverage = new Set();
      for (let wi = 0; wi < n; wi++) {
        if (!otherCoverage.has(wi)) needCoverage.add(wi);
      }
      if (needCoverage.size === 0) continue;

      // Greedy cover using all valid prefix-P features
      const availPFeats = allFeatures.filter(f => f.pattern[0] === prefix);
      const newPFeats = greedyCoverSet(needCoverage, availPFeats);
      if (newPFeats.length === 0) continue;

      // Only try if different from current
      const newSet = new Set(newPFeats);
      const currSet = new Set(currentPFeats);
      if (newSet.size === currSet.size && [...newSet].every(p => currSet.has(p))) continue;

      const test = pruneRedundant([...others, ...newPFeats], allFeatures, n);
      const len = measureLen(test);
      if (len < currentLen) {
        current = test;
        currentLen = len;
        improved = true;
        break;
      }
    }
  }
  return current;
}

// ─── Saturation search ────────────────────────────────────────────────────
// For each first-character prefix, greedily cover ALL words that any prefix-P
// feature can reach, then add those features and prune.  Unlike prefixClusterSearch
// (which only covers words not already covered by other prefixes), this allows
// prefix-P features to REPLACE features from other prefixes — e.g. 'a'-prefix
// features {ab,ak,am,at} can subsume {la,ki,ep} while compressing to a[bkmt].

function saturationSearch(selected, allFeatures, n) {
  const prefixes = [...new Set(allFeatures.map(f => f.pattern[0]))];
  let current = selected;
  let currentLen = measureLen(current);
  let improved = true;

  while (improved) {
    improved = false;
    for (const prefix of prefixes) {
      const availPFeats = allFeatures.filter(f => f.pattern[0] === prefix);
      if (availPFeats.length === 0) continue;

      const pCoverable = new Set();
      for (const f of availPFeats) f.covers.forEach(wi => pCoverable.add(wi));
      if (pCoverable.size === 0) continue;

      // Try two candidates: greedy minimum cover, and full prefix set (let
      // pruneRedundant select the optimal subset after adding everything).
      // The full-set approach can find clusters the greedy ordering misses.
      const greedyCover = greedyCoverSet(pCoverable, availPFeats);
      const fullCover = availPFeats.map(f => f.pattern);
      const toTry = [greedyCover];
      if (fullCover.length !== greedyCover.length) toTry.push(fullCover);

      for (const pCover of toTry) {
        if (pCover.length === 0) continue;
        const test = pruneRedundant([...current, ...pCover], allFeatures, n);
        const len = measureLen(test);
        if (len < currentLen) {
          current = test;
          currentLen = len;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return current;
}

// Greedy set cover: pick features from `features` to cover all words in `needCoverage`.
function greedyCoverSet(needCoverage, features) {
  const covered = new Set();
  const selected = [];

  while (covered.size < needCoverage.size) {
    let best = null, bestNC = 0;
    for (const f of features) {
      let nc = 0;
      for (const wi of f.covers) {
        if (needCoverage.has(wi) && !covered.has(wi)) nc++;
      }
      if (nc > bestNC || (nc === bestNC && best && f.pattern.length < best.pattern.length)) {
        bestNC = nc; best = f;
      }
    }
    if (!best || bestNC === 0) return []; // Can't cover
    selected.push(best.pattern);
    best.covers.forEach(wi => { if (needCoverage.has(wi)) covered.add(wi); });
  }
  return selected;
}

// ─── Feature generation ────────────────────────────────────────────────────

function generateFeatures(includeList, excludeList) {
  const includeTagged = includeList.map(w => `^${w}$`);
  const excludeTagged = excludeList.map(w => `^${w}$`);

  // Find the max of min-valid-feature-lengths (determines minimum pattern length needed)
  let maxLen = 0;
  for (const word of includeTagged) {
    outerLoop: for (let size = 1; size <= word.length; size++) {
      for (let pos = 0; pos <= word.length - size; pos++) {
        if (!excludeTagged.some(ew => ew.includes(word.slice(pos, pos + size)))) {
          if (size > maxLen) maxLen = size;
          break outerLoop;
        }
      }
    }
  }
  const lenCap = Math.min(maxLen + 1, 10);

  // Collect all valid substrings globally with their include-word coverage
  const validMap = new Map(); // pattern → Set<include_index> | null (invalid)

  for (let i = 0; i < includeTagged.length; i++) {
    const word = includeTagged[i];
    for (let size = 1; size <= Math.min(word.length, lenCap); size++) {
      for (let pos = 0; pos <= word.length - size; pos++) {
        const sub = word.slice(pos, pos + size);
        if (validMap.has(sub)) {
          const v = validMap.get(sub);
          if (v !== null) v.add(i);
          continue;
        }
        if (excludeTagged.some(ew => ew.includes(sub))) {
          validMap.set(sub, null);
        } else {
          validMap.set(sub, new Set([i]));
        }
      }
    }
  }

  const allFeatures = [];
  for (const [pattern, covers] of validMap) {
    if (covers !== null) allFeatures.push({ pattern, covers });
  }

  // Beam search candidates: deduplicate by coverage set (keep shortest per set).
  // This drastically reduces search space while preserving optimality for the
  // greedy-style selection within the beam.
  const byKey = new Map();
  for (const f of allFeatures) {
    const key = [...f.covers].sort((a, b) => a - b).join(',');
    const existing = byKey.get(key);
    if (!existing || f.pattern.length < existing.pattern.length) {
      byKey.set(key, f);
    }
  }
  const candidates = [...byKey.values()].sort((a, b) => a.pattern.length - b.pattern.length);

  return { candidates, allFeatures };
}

// ─── Tighten prune ────────────────────────────────────────────────────────
// Tries removing each feature; only accepts if coverage stays complete AND
// the regex actually gets shorter. Strictly better than pruneRedundant which
// removes coverage-redundant features without checking if it helps length.

function tightenPrune(selected, allFeatures, n) {
  const featMap = buildFeatMap(allFeatures);
  let current = selected;
  let currentLen = measureLen(current);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < current.length; i++) {
      const test = current.filter((_, j) => j !== i);
      const covered = new Set();
      for (const pat of test) {
        const f = featMap.get(pat);
        if (f) f.covers.forEach(wi => covered.add(wi));
      }
      if (covered.size < n) continue;
      const len = measureLen(test);
      if (len < currentLen) {
        current = test;
        currentLen = len;
        improved = true;
        break;
      }
    }
  }
  return current;
}

// ─── Prune redundant ──────────────────────────────────────────────────────

function pruneRedundant(selected, allFeatures, n) {
  const wordCoveredBy = buildWordCoveredBy(selected, allFeatures, n);
  const active = new Set(selected.map((_, i) => i));

  for (const fi of [...active]) {
    const f = allFeatures.find(f => f.pattern === selected[fi]);
    if (!f) continue;
    let canRemove = true;
    for (const wi of f.covers) {
      let activeCount = 0;
      for (const fj of wordCoveredBy[wi]) {
        if (active.has(fj)) activeCount++;
      }
      if (activeCount <= 1) { canRemove = false; break; }
    }
    if (canRemove) active.delete(fi);
  }

  return selected.filter((_, fi) => active.has(fi));
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function buildFeatMap(allFeatures) {
  return new Map(allFeatures.map(f => [f.pattern, f]));
}

function buildWordCoveredBy(selected, allFeatures, n) {
  const featMap = buildFeatMap(allFeatures);
  const wordCoveredBy = Array.from({ length: n }, () => new Set());
  for (let fi = 0; fi < selected.length; fi++) {
    const f = featMap.get(selected[fi]);
    if (f) f.covers.forEach(wi => wordCoveredBy[wi].add(fi));
  }
  return wordCoveredBy;
}

function countNew(covers, covered) {
  let count = 0;
  for (const wi of covers) {
    if (!covered.has(wi)) count++;
  }
  return count;
}

function measureLen(patterns) {
  try {
    return optimizeRegex(unescapeStartEnd(regexgen(patterns))).toString().length;
  } catch (e) {
    return Infinity;
  }
}

function sanityCheck(regex, includeList, excludeList) {
  const matchedBad = excludeList.filter(e => regex.test(e));
  const unmatchedBad = includeList.filter(i => !regex.test(i));
  if (matchedBad.length || unmatchedBad.length) {
    throw new Error(`matched: ${matchedBad.join(', ')}; unmatched: ${unmatchedBad.join(', ')}`);
  }
}

function unescapeStartEnd(regex) {
  return new RegExp(
    regex.source
      .replace(/\\(\^|\$)/g, '$1')
      .replace(/\[([^\]]*)(\^|\$)([^\]]*)\]/g, '(?:$2|[$1$3])')
  );
}

function optimizeRegex(regex) {
  let src = regex.source
    .replace(/\(\?\:/g, '(')
    .replace(/\\-/g, '-')
    .replace(/\\x2[Dd]/g, '-')   // regexgen sometimes escapes hyphens as \x2D
    .replace(/\[(.)\]/g, '$1')
    .replace(/\|\[(.)(.)\](\)|\||$)/, '|$1|$2$3')
    .replace(/(\)|\||^)\[(.)(.)\]\|/, '$1$2|$3|')
    .replace(/\|(.)\((.)\|(.)\)(\)|\||$)/, '|$1$2|$1$3$4')
    .replace(/(\)|\||^)(.)\((.)\|(.)\)\|/, '$1$2$3|$2$4|');

  // Expand 1-char-prefix + 2-alternative groups: x(A|B) → xA|xB (always saves 1 char).
  // Only when at least one alternative is multi-char (single-char alts are better
  // as char classes which regexgen already produces).
  // Applied repeatedly since expanding may expose further candidates.
  let prev;
  do {
    prev = src;
    src = src.replace(
      /([a-zA-Z0-9\-_$^])\(([^|)(]+)\|([^|)(]+)\)/g,
      (match, x, a, b) => {
        if (a.length === 1 && b.length === 1) return match; // keep as char class
        return x + a + '|' + x + b;
      }
    );
  } while (src !== prev);

  return new RegExp(src);
}
