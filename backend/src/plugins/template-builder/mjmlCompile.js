// Compile an MJML source string to email-safe HTML (table-based + inline CSS).
// Throws if the MJML contains errors so callers get a clean rejection.
// mjml is imported lazily so the backend can start even if the package is not yet installed.
export async function compileMjml(mjmlSource) {
  const { default: mjml2html } = await import('mjml');
  const { html, errors } = await mjml2html(mjmlSource, { validationLevel: 'strict' });
  if (errors && errors.length > 0) {
    const msg = errors.map(e => e.formattedMessage || e.message || String(e)).join('; ');
    throw new Error(`MJML compile error: ${msg}`);
  }
  return html;
}
