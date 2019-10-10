const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const getRegex = require("./index");
const regexgen = require('regexgen');
const randomWord = require('random-word');

const wordLists = {
  numericProps: [
    'animation-iteration-count',
    'border-image-outset',
    'border-image-slice',
    'border-image-width',
    'column-count',
    'fill-opacity',
    'flex-grow',
    'flex-shrink',
    'flood-opacity',
    'font-weight',
    'line-height',
    'opacity',
    'order',
    'orphans',
    'shape-image-threshold',
    'stop-opacity',
    'stroke-miterlimit',
    'stroke-opacity',
    'tab-size',
    'widows',
    'z-index',
    'zoom'
  ],
  pxProps: [
    'background-size',
    'baseline-shift',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
    'border-bottom-width',
    'border-left-width',
    'border-right-width',
    'border-top-left-radius',
    'border-top-right-radius',
    'border-top-width',
    'bottom',
    'column-gap',
    'column-rule-width',
    'column-width',
    'cx',
    'cy',
    'flex-basis',
    'font-size',
    'grid-auto-columns',
    'grid-auto-rows',
    'height',
    'left',
    'letter-spacing',
    'margin-bottom',
    'margin-left',
    'margin-right',
    'margin-top',
    'max-height',
    'max-width',
    'min-height',
    'min-width',
    'offset-distance',
    'outline-offset',
    'outline-width',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'padding-top',
    'perspective',
    'r',
    'right',
    'row-gap',
    'rx',
    'ry',
    'shape-margin',
    'stroke-dashoffset',
    'stroke-width',
    'text-indent',
    'top',
    'vertical-align',
    'width',
    'word-spacing',
    'x',
    'y'
  ],
  random1: [
    'connumeration-simplicial',
    'recognizors-oratorical',
    'sandhill',
    'glam',
    'eliads-labiality',
    'extensification',
    'hyperexcretion-acceptabilities',
    'echocardiography',
    'anchoring-disagreement',
    'rotunded-depicting',
    'medullas-malaroma',
    'miscolours',
    'unseen',
    'snitch',
    'chappatis-fastens',
    'chunkier-overmanaging',
    'costivenesses-nulliparae',
    'endocrinal',
    'teriyaki',
    'chamberpot',
    'pinakoidal-dacoities',
    'hyperplanes',
    'inhabitancies',
    'gardenfuls',
    'ingressive-eyewink'
  ],
  random2: [ 
    'humoresques',
    'algebraist',
    'achalasia',
    'off-meagernesses',
    'tallats-scaffs',
    'cooled',
    'dwiles-inessive',
    'smallholders-cheerfulness',
    'chott',
    'glitziness-jeanettes',
    'buccally-sandpipers',
    'teocallis-pisos',
    'disavouching',
    'versing-hatreds',
    'conductress-malentendu',
    'deaeration',
    'apportioned',
    'mailmerges',
    'sponge-weathercloth',
    'bashfully-skrimping',
    'bioluminescent-piecener',
    'dilative',
    'headachier',
    'unman-freecycling',
    'camorrista',
    'liturgy-invectives',
    'dewberries-catafalco',
    'pryse',
    'virtuosas',
    'democratize',
    'stomates',
    'clinics-tuboplasty',
    'intracardiac-isopycnal',
    'unwarrantable-teliospore',
    'interess-warrantable',
    'imbibitions',
    'copulated-shankpiece',
    'parkis',
    'maidservant',
    'tempestuousness-appartements'
  ]
}

// console.log(Array(40).fill(0).map(() => Math.random() < 0.5 ? randomWord() : randomWord() + "-" + randomWord()));

// const a = numericProps || Array(25).fill(0).map(randomWord);
// const b = pxProps || Array(50).fill(0).map(randomWord).filter(b => !a.includes(b));
// console.log(a);
// console.log(b);
// test(numericProps, pxProps);
// test(more1, more2);
// test(numericProps, more1);
// test(numericProps, more2);
// test(pxProps, more1);
// test(pxProps, more2);

testAll();

function testAll() {
  const listNames = Object.keys(wordLists);
  const bestsPath = path.join(__dirname, "bests.json");
  const bests = JSON.parse(fs.readFileSync(bestsPath));
  const currents = {};
  for (let i = 0; i < listNames.length; i++) {
    const first = listNames[i];
    for (let j = i + 1; j < listNames.length; j++) {
      const second = listNames[j];
      currents[`${first}/${second}`] = test(first, second);
      currents[`${second}/${first}`] = test(second, first);
    }
  }
  let update = false;
  for(let key in currents) {
    const current = currents[key];
    const best = bests[key];
    const currentLength = current.small.length;
    const bestLength = best && best.small.length;
    const color = !best ? chalk.yellow : bestLength < currentLength ? chalk.red : currentLength < bestLength ? chalk.cyan : chalk.green;
    console.log(`${key} ${current.default.length}`);
    console.log(color(`${current.small} ${currentLength}`))
    if (best && best.small !== current.small) {
      console.log(chalk.dim(`${best.small} ${bestLength}`));
    }
    console.log("");
    if (!best || currentLength < bestLength) {
      update = true;
      bests[key] = current;
    }
  }
  if (update) {
    fs.writeFileSync(bestsPath, JSON.stringify(bests, null, 2));
  }
}

function test(firstName, secondName) {
  const firstList = wordLists[firstName];
  const secondList = wordLists[secondName];
  return { small: getRegex(firstList, secondList).toString(), default: regexgen(firstList).toString() };
}