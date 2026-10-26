function buildContextMenu(params, { openLink, copyText, print }) {
  const template = [];
  const hasSelection = Boolean(params.selectionText?.trim());
  const hasImage = params.mediaType === 'image' && Boolean(params.srcURL);
  if (params.isEditable) {
    return [
      { label: 'Cut', role: 'cut' }, { label: 'Copy', role: 'copy', enabled: hasSelection },
      { label: 'Paste', role: 'paste' }, { type: 'separator' }, { label: 'Select All', role: 'selectAll' },
    ];
  }
  if (params.linkURL) {
    template.push(
      { label: 'Open Link', click: () => openLink(params.linkURL) },
      { label: 'Copy Link', click: () => copyText(params.linkURL) },
    );
  }
  if (hasImage) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: 'Copy Image Address', click: () => copyText(params.srcURL) });
  }
  if (hasSelection) {
    if (template.length) template.push({ type: 'separator' });
    template.push({ label: 'Copy', role: 'copy' }, { label: 'Select All', role: 'selectAll' });
  }
  if (hasImage || hasSelection) {
    template.push({ type: 'separator' }, { label: 'Print', click: print });
  }
  return template;
}

module.exports = { buildContextMenu };
