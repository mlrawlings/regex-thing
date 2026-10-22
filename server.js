const http = require('http');
const fs = require('fs');
const path = require('path');
const getRegex = require('./index');

const html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'POST' && req.url === '/regex') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch { return respond(res, 400, { error: 'Invalid JSON' }); }

      const { includeList, excludeList } = parsed;
      if (!Array.isArray(includeList) || !Array.isArray(excludeList)) {
        return respond(res, 400, { error: 'includeList and excludeList must be arrays' });
      }

      try {
        const regex = getRegex(includeList, excludeList);
        respond(res, 200, { regex: regex.toString() });
      } catch (e) {
        respond(res, 400, { error: e.message });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
