// Minimal 301 redirector for the retired tool subdomains during cutover.
// Deployed to the old Web Apps (Easy Auth set to AllowAnonymous) so every
// bookmark lands on the corresponding path under figureskatingtools.com.
// TARGET_URL example: https://figureskatingtools.com/judgepapers/
const http = require('http');

const PORT = process.env.PORT || 8080;
const TARGET_URL = (process.env.TARGET_URL || 'https://figureskatingtools.com/').replace(/\/+$/, '') + '/';

http.createServer((req, res) => {
    res.writeHead(301, { Location: TARGET_URL, 'Cache-Control': 'no-cache' });
    res.end(`Moved permanently to ${TARGET_URL}`);
}).listen(PORT, () => console.log(`Redirecting all requests to ${TARGET_URL} (port ${PORT})`));
