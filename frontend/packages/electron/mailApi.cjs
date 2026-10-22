const http = require('http');
const https = require('https');

function sendMailFlowApiRequest(url, { method, body, cookies } = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = (parsedUrl.protocol === 'http:' ? http : https).request(parsedUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        // The API's CSRF gate rejects a mutating request without this header.
        'X-Requested-With': 'MailFlow',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (response) => {
      response.resume();
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve();
          return;
        }

        reject(new Error(`Mail action failed with status ${response.statusCode}`));
      });
    });

    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

module.exports = {
  sendMailFlowApiRequest,
};
