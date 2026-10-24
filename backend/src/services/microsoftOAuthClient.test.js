import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));
import { getMsDeviceClient, msPersonalAccountsAvailable, msPersonalSignInVia, msWorkAccountsAvailable } from './microsoftOAuthClient.js';

const KEYS = ['MS_CLIENT_ID', 'MS_TENANT_ID', 'MS_BUILTIN_APP'];
const saved = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const shared = { clientId: 'builtin-app-id', tenantId: 'consumers', builtin: true };
const own = (tenantId) => ({ clientId: 'own-app-id', tenantId, builtin: false });

// Which app a new device-code sign-in uses, by the kind of account (#674): personal accounts
// fall back to MailFlow's shared app when the instance's own app cannot sign them in.
describe('getMsDeviceClient(kind)', () => {
  it.each([
    // [own app tenant (undefined: no own app), shared app on, personal client, work client]
    [undefined, true, shared, null],
    [undefined, false, null, null],
    ['common', true, own('common'), own('common')],
    ['common', false, own('common'), own('common')],
    ['consumers', true, own('consumers'), null],
    ['organizations', true, shared, own('organizations')],
    ['organizations', false, null, own('organizations')],
    ['contoso.example', true, shared, own('contoso.example')],
  ])('own app on %s, shared app on: %s', (tenant, sharedOn, personal, work) => {
    if (tenant !== undefined) { process.env.MS_CLIENT_ID = 'own-app-id'; process.env.MS_TENANT_ID = tenant; }
    process.env.MS_BUILTIN_APP = String(sharedOn);
    expect(getMsDeviceClient('personal')).toEqual(personal);
    expect(getMsDeviceClient('work')).toEqual(work);
    expect(msPersonalAccountsAvailable()).toBe(personal !== null);
    expect(msPersonalSignInVia()).toBe(personal === null ? null : personal.builtin ? 'shared' : 'own');
    expect(msWorkAccountsAvailable()).toBe(work !== null);
  });

  it('without a kind, behaves as before kinds existed: the own app whatever its tenant, else the shared one', () => {
    expect(getMsDeviceClient()).toEqual(shared);
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = 'organizations';
    expect(getMsDeviceClient()).toEqual(own('organizations'));
  });
});
