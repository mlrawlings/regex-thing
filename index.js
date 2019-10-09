const regexgen = require('regexgen');
const randomWord = require('random-word');

const numericProps = [
  "animation-iteration-count",
  "border-image-outset",
  "border-image-slice",
  "border-image-width",
  "column-count",
  "fill-opacity",
  "flex-grow",
  "flex-shrink",
  "flood-opacity",
  "font-weight",
  "line-height",
  "opacity",
  "order",
  "orphans",
  "shape-image-threshold",
  "stop-opacity",
  "stroke-miterlimit",
  "stroke-opacity",
  "tab-size",
  "widows",
  "z-index",
  "zoom"
];

const pxProps = [
  "background-size",
  "baseline-shift",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-width",
  "border-image-outset",
  "border-image-width",
  "border-left-width",
  "border-right-width",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-width",
  "bottom",
  "column-gap",
  "column-rule-width",
  "column-width",
  "cx",
  "cy",
  "flex-basis",
  "font-size",
  "grid-auto-columns",
  "grid-auto-rows",
  "height",
  "left",
  "letter-spacing",
  "line-height",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "offset-distance",
  "outline-offset",
  "outline-width",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "perspective",
  "r",
  "right",
  "row-gap",
  "rx",
  "ry",
  "shape-margin",
  "stroke-dashoffset",
  "stroke-width",
  "tab-size",
  "text-indent",
  "top",
  "vertical-align",
  "width",
  "word-spacing",
  "x",
  "y"
].filter(prop => !numericProps.includes(prop));

const startOrEnd = /\^|\$/;

const a = numericProps || Array(25).fill(0).map(randomWord);
const b = pxProps || Array(50).fill(0).map(randomWord).filter(b => !a.includes(b));
console.log(a);
console.log(b);
const regex = getRegex(a, b);
console.log(regex, regex.toString().length, a.join().length);
const reverse = getRegex(b, a);
console.log(reverse, reverse.toString().length, b.join().length);

function getRegex(includeList, excludeList) {
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
  let result = allPartials.map(partials => partials.map(p => ({ value: p })));

  do {
    result = result.map((partials, index) => partials.map(partial => {
      if (partial.locked) {
        return partial;
      }
      const value = partial.value;
      let count = 0;
      let minAddedSize = value.length;
      for (let i = 0; i < result.length; i++) {
        if (i !== index) {
          const other = result[i];
          for (let size = value.length; size > 0; size--) {
            const substring = value.slice(0, size);
            if (other.some(o => o.value.indexOf(substring) === 0)) {
              count += size/value.length;
              if (minAddedSize > value.length - size) {
                minAddedSize = value.length - size;
              }
              break;
            }
          }
        }
      }
      return { value, estimatedSize: (count*minAddedSize + value.length)/(count+1) };
    }).sort((a, b) => a.estimatedSize - b.estimatedSize));

    let bestMatch;

    for (let partials of result) {
      if (!partials[0].locked && (!bestMatch || partials[0].estimatedSize < bestMatch.estimatedSize)) {
        bestMatch = partials[0];
      }
    }

    if (bestMatch.value === "^or") {
      console.log(result);
    }

    result = result.map(partials => {
      if (partials[0].value === bestMatch.value) {
        return [{ ...partials[0], locked: true }];
      }
      return partials;
    });

  } while (!result.every(partial => partial.length === 1));

  // console.log(result.sort((a, b) => a[0].estimatedSize - b[0].estimatedSize));

  return result.map(p => p[0].value);
}