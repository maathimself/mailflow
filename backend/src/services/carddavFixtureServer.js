import http from 'node:http';
import { xmlEscape } from './carddavXml.js';

const PRINCIPAL_PATH = '/principals/fixture-user/';
const HOME_PATH = '/addressbooks/fixture-user/';
const BOOK_PATH = `${HOME_PATH}contacts/`;

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function multistatus(content) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
${content}
</D:multistatus>`;
}

function propResponse(href, properties) {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>
${properties}
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function cardResponse(contact) {
  return propResponse(contact.href, `<D:getetag>${xmlEscape(contact.etag)}</D:getetag>
<C:address-data>${xmlEscape(contact.vcard)}</C:address-data>`);
}

function removedResponse(href) {
  return `<D:response><D:href>${xmlEscape(href)}</D:href>
<D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, body = '', headers = {}) {
  const responseHeaders = { ...headers };
  if (body && !Object.keys(responseHeaders).some(name => name.toLowerCase() === 'content-type')) {
    responseHeaders['Content-Type'] = 'application/xml; charset=utf-8';
  }
  response.writeHead(status, responseHeaders);
  response.end(body);
}

export function createCarddavFixtureServer() {
  const contacts = new Map();
  const syncResponses = new Map();
  const multigetResponses = [];
  const discoveryResponses = [];
  const writeResponses = new Map();
  const redirects = new Map();
  let origin;
  let writeRevision = 0;
  const counters = {
    requests: 0,
    propfind: 0,
    sync: 0,
    multiget: 0,
    addressbookQuery: 0,
    fetch: 0,
    create: 0,
    update: 0,
    delete: 0,
    requestUri507: 0,
    snapshotFilters: [],
    syncTokens: [],
    multigetSizes: [],
  };
  const requests = [];

  function absoluteHref(href) {
    return new URL(href, `${origin}${BOOK_PATH}`).href;
  }

  function queueSync(token, scriptedResponse) {
    const queue = syncResponses.get(token) || [];
    queue.push(scriptedResponse);
    syncResponses.set(token, queue);
  }

  function takeSync(token) {
    const queue = syncResponses.get(token);
    if (!queue?.length) {
      throw new Error(`No CardDAV fixture response queued for token ${JSON.stringify(token)}`);
    }
    return queue.shift();
  }

  function takeWrite(method) {
    const queue = writeResponses.get(method);
    return queue?.shift();
  }

  const server = http.createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const url = new URL(request.url, origin || 'http://127.0.0.1');
      counters.requests++;
      requests.push({
        method: request.method,
        origin: url.origin,
        path: url.pathname,
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        contentType: request.headers['content-type'],
        depth: request.headers.depth,
        ifMatch: request.headers['if-match'],
        ifNoneMatch: request.headers['if-none-match'],
        body,
      });

      const redirectKey = `${request.method} ${url.pathname}`;
      const redirectQueue = redirects.get(redirectKey);
      if (redirectQueue?.length) {
        const redirect = redirectQueue.shift();
        response.writeHead(redirect.status || 301, { Location: redirect.location });
        response.end();
        return;
      }

      if (request.method === 'PROPFIND') {
        counters.propfind++;
        if (url.pathname === '/' || url.pathname === '/dav/') {
          return send(response, 207, multistatus(propResponse(
            url.pathname,
            `<D:current-user-principal><D:href>${PRINCIPAL_PATH}</D:href></D:current-user-principal>`,
          )));
        }
        if (url.pathname === PRINCIPAL_PATH) {
          return send(response, 207, multistatus(propResponse(
            PRINCIPAL_PATH,
            `<C:addressbook-home-set><D:href>${HOME_PATH}</D:href></C:addressbook-home-set>`,
          )));
        }
        if (url.pathname === HOME_PATH) {
          const scripted = discoveryResponses.shift();
          if (scripted?.status && scripted.status !== 207) {
            return send(
              response,
              scripted.status,
              scripted.rawBody || '',
              scripted.headers || {},
            );
          }
          if (scripted && Object.hasOwn(scripted, 'rawBody')) {
            return send(response, scripted.status || 207, scripted.rawBody);
          }
          const reports = `<D:supported-report-set>
  <D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>
  <D:supported-report><D:report><C:addressbook-multiget/></D:report></D:supported-report>
</D:supported-report-set>`;
          const homeResponse = propResponse(
            HOME_PATH,
            '<D:resourcetype><D:collection/></D:resourcetype>',
          );
          const books = scripted && Object.hasOwn(scripted, 'books')
            ? scripted.books
            : [{ href: BOOK_PATH, displayName: 'Fixture Contacts' }];
          const bookResponses = books.map(book => {
            const privileges = Object.hasOwn(book, 'privileges')
              ? book.privileges
              : ['bind', 'write-content', 'unbind'];
            const addressData = Object.hasOwn(book, 'addressData')
              ? book.addressData
              : [
                { contentType: 'text/vcard', version: '4.0' },
                { contentType: 'text/vcard', version: '3.0' },
              ];
            const privilegeProperty = privileges === false ? '' : `
<D:current-user-privilege-set>${privileges.map(privilege => (
  `<D:privilege><D:${privilege}/></D:privilege>`
)).join('')}</D:current-user-privilege-set>`;
            const addressDataProperty = addressData === false ? '' : `
<C:supported-address-data>${addressData.map(entry => (
  `<C:address-data-type content-type="${xmlEscape(entry.contentType)}" version="${xmlEscape(entry.version)}"/>`
)).join('')}</C:supported-address-data>`;
            return propResponse(
              book.href || BOOK_PATH,
              `<D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
<D:displayname>${xmlEscape(book.displayName || 'Fixture Contacts')}</D:displayname>${
  book.reports === false ? '' : reports
}${privilegeProperty}${addressDataProperty}`,
            );
          });
          return send(response, 207, multistatus([homeResponse, ...bookResponses].join('\n')));
        }
      }

      if (['GET', 'PUT', 'DELETE'].includes(request.method)
        && url.pathname.startsWith(HOME_PATH)
        && !url.pathname.endsWith('/')) {
        const href = url.href;
        const existing = contacts.get(href);
        const scripted = takeWrite(request.method);

        if (scripted) {
          return send(
            response,
            scripted.status,
            scripted.rawBody || '',
            scripted.headers || {},
          );
        }

        if (request.method === 'GET') {
          counters.fetch++;
          if (!existing) return send(response, 404);
          return send(response, 200, existing.vcard, {
            'Content-Type': 'text/vcard; charset=utf-8',
            ETag: existing.etag,
          });
        }

        if (request.method === 'PUT') {
          const creating = request.headers['if-none-match'] === '*'
            && request.headers['if-match'] == null;
          const updating = request.headers['if-match'] != null
            && request.headers['if-none-match'] == null;
          if (!creating && !updating) return send(response, 428);
          if (creating && existing) return send(response, 412);
          if (updating && (!existing || request.headers['if-match'] !== existing.etag)) {
            return send(response, 412);
          }
          if (!request.headers['content-type']?.startsWith('text/vcard')) {
            return send(response, 415);
          }
          const etag = `"fixture-write-${++writeRevision}"`;
          contacts.set(href, { href, etag, vcard: body });
          counters[creating ? 'create' : 'update']++;
          return send(response, creating ? 201 : 204, '', { ETag: etag });
        }

        counters.delete++;
        if (!existing) return send(response, 404);
        if (request.headers['if-match'] !== existing.etag) return send(response, 412);
        contacts.delete(href);
        return send(response, 204);
      }

      if (request.method === 'REPORT'
        && url.pathname.startsWith(HOME_PATH)
        && url.pathname !== HOME_PATH) {
        if (body.includes('<sync-collection')) {
          counters.sync++;
          const token = unescapeXml(body.match(/<sync-token>([\s\S]*?)<\/sync-token>/)?.[1] || '');
          counters.syncTokens.push(token);
          const scripted = takeSync(token);
          if (scripted.waitFor) {
            scripted.reached?.();
            await scripted.waitFor;
          }
          if (Object.hasOwn(scripted, 'rawBody')) {
            return send(response, scripted.status || 207, scripted.rawBody);
          }
          if (scripted.status && scripted.status !== 207) {
            const error = scripted.precondition
              ? `<D:error xmlns:D="DAV:"><D:${scripted.precondition}/></D:error>`
              : '';
            return send(response, scripted.status, error);
          }
          const events = (scripted.events || []).map(event => {
            const href = event.rawHref ?? absoluteHref(event.href);
            if (event.status === 404) return removedResponse(href);
            return propResponse(
              href,
              `<D:getetag>${xmlEscape(event.etag)}</D:getetag>`,
            );
          });
          if (scripted.truncated) {
            counters.requestUri507++;
            events.push(`<D:response><D:href>${BOOK_PATH}</D:href>
<D:status>HTTP/1.1 507 Insufficient Storage</D:status></D:response>`);
          }
          return send(response, 207, multistatus(
            `${events.join('\n')}<D:sync-token>${xmlEscape(scripted.nextToken)}</D:sync-token>`,
          ));
        }

        if (body.includes('<C:addressbook-multiget')) {
          counters.multiget++;
          const hrefs = [...body.matchAll(/<D:href>([\s\S]*?)<\/D:href>/g)]
            .map(match => absoluteHref(unescapeXml(match[1])));
          counters.multigetSizes.push(hrefs.length);
          const scripted = multigetResponses.shift();
          if (scripted?.status && scripted.status !== 207) {
            return send(response, scripted.status, scripted.rawBody || '');
          }
          if (scripted && Object.hasOwn(scripted, 'rawBody')) {
            return send(response, scripted.status || 207, scripted.rawBody);
          }
          const responses = hrefs.map(href => {
            const contact = contacts.get(href);
            return contact ? cardResponse(contact) : removedResponse(href);
          });
          return send(response, 207, multistatus(responses.join('\n')));
        }

        if (body.includes('<C:addressbook-query')) {
          counters.addressbookQuery++;
          const filterCount = body.match(/<C:filter\/>/g)?.length || 0;
          counters.snapshotFilters.push(filterCount);
          if (filterCount !== 1) {
            return send(response, 400, '<error>snapshot query requires one CardDAV filter</error>');
          }
          const responses = [...contacts.values()]
            .sort((a, b) => a.href.localeCompare(b.href))
            .map(cardResponse);
          return send(response, 207, multistatus(responses.join('\n')));
        }
      }

      return send(response, 404);
    } catch (error) {
      return send(response, 500, `<error>${xmlEscape(error.message)}</error>`);
    }
  });

  return {
    counters,
    requests,
    get serverUrl() { return `${origin}/`; },
    href(name) { return absoluteHref(name); },
    putContact(href, etag, vcard) {
      const absolute = absoluteHref(href);
      contacts.set(absolute, { href: absolute, etag, vcard });
    },
    deleteContact(href) {
      contacts.delete(absoluteHref(href));
    },
    reset() {
      counters.requests = 0;
      counters.propfind = 0;
      counters.sync = 0;
      counters.multiget = 0;
      counters.addressbookQuery = 0;
      counters.fetch = 0;
      counters.create = 0;
      counters.update = 0;
      counters.delete = 0;
      counters.requestUri507 = 0;
      counters.snapshotFilters.length = 0;
      counters.syncTokens.length = 0;
      counters.multigetSizes.length = 0;
      requests.length = 0;
      syncResponses.clear();
      multigetResponses.length = 0;
      discoveryResponses.length = 0;
      writeResponses.clear();
      redirects.clear();
    },
    queueSync,
    queueDiscovery(scriptedResponse) {
      discoveryResponses.push(scriptedResponse);
    },
    queueRedirect(method, path, location, status = 301) {
      const key = `${method} ${path}`;
      const queue = redirects.get(key) || [];
      queue.push({ location, status });
      redirects.set(key, queue);
    },
    queueWrite(method, scriptedResponse) {
      const queue = writeResponses.get(method) || [];
      queue.push(scriptedResponse);
      writeResponses.set(method, queue);
    },
    queueMultiget(scriptedResponse) {
      multigetResponses.push(scriptedResponse);
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => (
        error ? reject(error) : resolve()
      )));
    },
  };
}
