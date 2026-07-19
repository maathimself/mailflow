// On-demand ReDoS audit config — NOT part of CI or `npm run lint`.
//
// Run it with `npm run audit:redos` (which installs eslint-plugin-redos with
// --no-save, so nothing lands in package.json / package-lock.json). It flags
// regex literals whose worst-case is super-linear (polynomial/exponential),
// using the `recheck` engine.
//
// Why it's manual rather than in CI: the dangerous class — paired
// `open …[\s\S]*?… close` tag regexes with the /g-times-lazy amplifier that
// froze the snippet and email-render paths — is already fixed (htmlparser2 for
// snippets, scanPaired for the sanitizer). What the rule still reports is a set
// of lower-severity single-`[^x]*` patterns; wiring it to block CI would force
// ~20 baseline suppressions in XSS-critical code for little gain. Instead, run
// this before adding any new HTML/text-processing regex to catch a regression
// early. If a future pass makes those files fully linear, promote the rule into
// eslint.config.js at that point.
import base from './eslint.config.js';
import redos from 'eslint-plugin-redos';

export default [
  ...base,
  {
    files: ['**/*.js'],
    plugins: { redos },
    rules: { 'redos/no-vulnerable': 'error' },
  },
];
