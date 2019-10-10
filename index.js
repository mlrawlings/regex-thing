const regexgen = require('regexgen');
const startOrEnd = /\^|\$/;

module.exports = function getRegex(includeList, excludeList) {
  let bad;
  if (bad = includeList.find(i => excludeList.includes(i))) {
    throw new Error(`"${bad}" is included in both the include and exclude lists`);
  } else if (bad = includeList.concat(excludeList).find(w => startOrEnd.test(w))) {
    throw new Error(`"${bad}" contains ^ or $ which is not supported`);
  }

  const bestPartials = findBestPartials(filterPartialsByLength(getAllPartials(includeList, excludeList)));
  const regex = optimizeRegex(unescapeStartEnd(regexgen(bestPartials)));

  sanityCheck(regex, includeList, excludeList);

  return regex;
}

function sanityCheck(regex, includeList, excludeList) {
  const matchedBad = excludeList.filter(e => regex.test(e));
  const unmatchedBad = includeList.filter(i => !regex.test(i));
  if (matchedBad.length || unmatchedBad.length) {
    throw new Error(`matched: ${matchedBad.join(", ")}; unmatched: ${unmatchedBad.join(", ")}`);
  }
}

function unescapeStartEnd(regex) {
  return new RegExp(regex.source.replace(/\\(\^|\$)/g, "$1").replace(/\[([^\]]*)(\^|\$)([^\]]*)\]/g, "(?:$2|[$1$3])"));
}

function optimizeRegex(regex) {
  return new RegExp(
    regex.source
      .replace(/\(\?\:/g, "(")
      .replace(/\\-/g, "-")
      .replace(/\[(.)\]/g, "$1")
      .replace(/\|\[(.)(.)\](\)|\||$)/, "|$1|$2$3")
      .replace(/(\)|\||^)\[(.)(.)\]\|/, "$1$2|$3|")
      .replace(/\|(.)\((.)\|(.)\)(\)|\||$)/, "|$1$2|$1$3$4")
      .replace(/(\)|\||^)(.)\((.)\|(.)\)\|/, "$1$2$3|$2$4|")
  );
}

/**
 * Find every possible substring for words in includeList.
 * Filter out substrings that match the words in excludeList.
 * @param {string[]} includeList 
 * @param {string[]} excludeList 
 */
function getAllPartials(includeList, excludeList) {
  includeList = includeList.map(prop => `^${prop}$`);
  excludeList = excludeList.map(prop => `^${prop}$`);

  const includePartials = [];
  for (const includeWord of includeList) {
    const wordPartials = [];
    includePartials.push(wordPartials);
    for (let size = 1; size <= includeWord.length; size++) {
      for (let pos = 0; pos <= includeWord.length-size; pos++) {
        const substring = includeWord.slice(pos, size+pos);
        if (!excludeList.some(excludeWord => excludeWord.includes(substring))) {
          wordPartials.push(substring);
        }
      }
    }
  }

  return includePartials;
}

/**
 * For each word, the first substring is the shortest. Of these, find the longest.
 * Filter each word's substring array so that they are at most this length.
 * This allows findBestPartials to run a reasonable amount of time.
 * @param {Array<string[]>} allPartials 
 */
function filterPartialsByLength(allPartials) {
  let maxLength = 0;
  for (const partials of allPartials) {
      const length = partials[0].length;
      if (length > maxLength) {
        maxLength = length;
      }
  }
  return allPartials.map(partials => partials.filter(p => p.length <= maxLength));
}

/**
 * Find the partials that will generate the smallest trie by:
 * 1. Estimate the size a partial will contribute (taking into account the other possible partials)
 * 2. Pick the partial the contributes the least size and lock it into place
 * 3. For each word that contained this partial, eliminate the other possible partials
 * 4. Repeat until all words have locked partials
 * @param {Array<string[]>} allPartials 
 */
function findBestPartials(allPartials) {
  let result = allPartials.map(partials => partials.map(p => ({ value: p, estimatedSize: p.length })));

  do {
    result = result.map((partials, index) => partials.map(partial => {
      if (partial.locked) {
        return partial;
      }
      const value = partial.value;
      const matches = [{ size:value.length, chance:1 }];
      for (let i = 0; i < result.length; i++) {
        if (i !== index) {
          const other = result[i];
          for (let size = value.length; size > 0; size--) {
            const substring = value.slice(0, size);
            const otherIndex = other.findIndex(o => o.value.indexOf(substring) === 0);
            if (otherIndex !== -1) {
              const ratio = (other.length-otherIndex)/Math.pow(other.length, 1.5);
              matches.push({ size:value.length - size, chance: ratio });
              break;
            }
          }
        }
      }
      matches.sort((a, b) => a.size - b.size);
      let estimatedSize = 0;
      let done = 0; 
      for (const { size, chance } of matches) {
        const ratio = (1-done) * chance;
        estimatedSize += size * ratio;
        done += ratio;
      }
      return { value, estimatedSize };
    }).sort((a, b) => a.estimatedSize - b.estimatedSize));

    for (let partials of result) {
      if (partials.length > 1) {
        partials[0].savings = partials[1].estimatedSize - partials[0].estimatedSize;
      } else {
        partials[0].savings = Infinity;
      }
    }

    let bestMatch;

    for (let partials of result) {
      // if (!partials[0].locked && (!bestMatch || partials[0].estimatedSize < bestMatch.estimatedSize)) {
      if (!partials[0].locked && (!bestMatch || partials[0].savings > bestMatch.savings)) {
        bestMatch = partials[0];
      }
    }

    result = result.map(partials => {
      if (partials.some(p => p.value === bestMatch.value)) {
        return [{ ...bestMatch, locked: true }];
      }
      return partials;
    });

  } while (!result.every(partial => partial.length === 1));

  // console.log(result.sort((a, b) => a[0].estimatedSize - b[0].estimatedSize));

  return result.map(p => p[0].value);
}