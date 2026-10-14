const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { sendMailFlowApiRequest } = require('./mailApi.cjs');

// Stands in for the CSRF gate in backend/src/index.js: a mutating request without X-Requested-With gets 403.
async function startApi(t) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(req.headers['x-requested-with'] ? 200 : 403, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { host: `http://127.0.0.1:${server.address().port}`, received };
}

const cookies = [{ name: 'connect.sid', value: 's%3Aabc' }];

test('a notification Delete passes the API CSRF gate', async (t) => {
  const { host, received } = await startApi(t);

  await sendMailFlowApiRequest(`${host}/api/mail/messages/m1`, { method: 'DELETE', cookies });

  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'DELETE');
  assert.equal(received[0].headers['x-requested-with'], 'MailFlow');
  assert.equal(received[0].url, '/api/mail/messages/m1');
  assert.equal(received[0].headers.cookie, 'connect.sid=s%3Aabc');
});

test('a notification Star passes the API CSRF gate', async (t) => {
  const { host, received } = await startApi(t);

  await sendMailFlowApiRequest(`${host}/api/mail/messages/m1/star`, { method: 'PATCH', body: { starred: true }, cookies });

  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'PATCH');
  assert.equal(received[0].headers['x-requested-with'], 'MailFlow');
  assert.equal(received[0].url, '/api/mail/messages/m1/star');
  assert.equal(received[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(received[0].body), { starred: true });
});
