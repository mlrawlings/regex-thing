#!/usr/bin/env node
// Produces standalone.html — runs getRegex in a Web Worker with no server.
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;

// 1. Bundle index.js + regexgen for the browser
const shimPath = path.join(root, '/tmp-shim.js');
fs.writeFileSync(shimPath, 'globalThis.Buffer={isBuffer:()=>false};\n');

execSync(
  `npx esbuild ${path.join(root,'index.js')}` +
  ` --bundle --platform=browser --format=iife --global-name=__getRegexMod` +
  ` --inject:${shimPath} --minify --outfile=${path.join(root,'tmp-bundle.js')}`,
  { stdio: 'inherit', cwd: root }
);

const bundle = fs.readFileSync(path.join(root, 'tmp-bundle.js'), 'utf8');
fs.unlinkSync(path.join(root, 'tmp-shim.js'));
fs.unlinkSync(path.join(root, 'tmp-bundle.js'));

// Worker source: bundle + message handler
const workerSrc = bundle + `
self.onmessage=function(e){
  var d=e.data;
  try{self.postMessage({regex:__getRegexMod(d.includeList,d.excludeList).toString()});}
  catch(x){self.postMessage({error:x.message});}
};`;

// 2. Transform ui.html
let html = fs.readFileSync(path.join(root, 'ui.html'), 'utf8');

// 2a. Inject worker setup code right before the WORD_LISTS comment
const workerSetup = `
    // ── Worker (no server needed) ─────────────────────────────────────────────
    const _workerSrc = ${JSON.stringify(workerSrc).replace(/</g, '\\u003c')};
    const _workerUrl = URL.createObjectURL(new Blob([_workerSrc], { type: 'application/javascript' }));
    let _worker = null, _workerReject = null;
    function workerCall(includeList, excludeList) {
      return new Promise((resolve, reject) => {
        if (_worker) {
          _worker.terminate();
          if (_workerReject) { _workerReject(Object.assign(new Error('cancelled'), {cancelled:true})); }
        }
        _workerReject = reject;
        _worker = new Worker(_workerUrl);
        _worker.onmessage = e => {
          _workerReject = null;
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data.regex);
        };
        _worker.onerror = e => { _workerReject = null; reject(new Error(e.message)); };
        _worker.postMessage({ includeList, excludeList });
      });
    }

`;

// Use a function to avoid $& $' $` special replacement patterns from the bundle
html = html.replace(
  '    // ── Word lists ───',
  () => workerSetup + '    // ── Word lists ───'
);

// 2b. Replace the fetch block with a workerCall
const fetchBlock = `      // Dim stale value in place; spinner appears via CSS class — no height change
      regexBar.classList.add('computing');

      if (abortCtrl) abortCtrl.abort();
      abortCtrl = new AbortController();

      try {
        const res = await fetch('/regex', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ includeList: incWords, excludeList: excWords }),
          signal: abortCtrl.signal,
        });
        const data = await res.json();

        regexBar.classList.remove('computing');

        if (data.error) {
          regexEl.innerHTML = \`<span class="error">\${esc(data.error)}</span>\`;
          return;
        }

        currentRegex = data.regex;`;

const workerBlock = `      regexBar.classList.add('computing');

      try {
        const _regex = await workerCall(incWords, excWords);
        const data = { regex: _regex };

        regexBar.classList.remove('computing');

        currentRegex = data.regex;`;

html = html.replace(fetchBlock, () => workerBlock);

// 2c. Replace the AbortError catch guard
html = html.replace(
  `        if (e.name === 'AbortError') return;`,
  `        if (e.cancelled) return;`
);

// 2d. Remove the abortCtrl variable declaration
html = html.replace(`    let currentRegex = '';
    let currentRe    = null;
    let timer, abortCtrl;`,
`    let currentRegex = '';
    let currentRe    = null;
    let timer;`);

// 3. Write output
const out = path.join(root, 'standalone.html');
fs.writeFileSync(out, html);
console.log(`Written: ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
