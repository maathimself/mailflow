// Attachment risk classification by file extension (the declared MIME type is
// sender-controlled and routinely wrong). Three levels:
//   block  — executables, scripts, installers, disk images, shortcuts: run code
//   warn   — macro-enabled Office, HTML/SVG (credential-harvesting pages)
//   notice — archives, whose contents nothing here can inspect
// A double extension ("invoice.pdf.exe") is classified by its real (last)
// extension and reports the hidden tail so the disguise is visible.

const BLOCK = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'msi', 'msp', 'mst', 'jar', 'hta', 'cpl', 'reg', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'dll', 'apk', 'application', 'appx',
  'sh', 'run', 'dmg', 'pkg', 'deb', 'rpm', 'chm', 'inf', 'scf', 'url', 'ade', 'adp', 'gadget', 'ws']);
const WARN = new Set(['docm', 'xlsm', 'pptm', 'xlam', 'dotm', 'xltm', 'potm', 'ppam', 'sldm', 'html', 'htm', 'shtml', 'xhtml', 'svg', 'mht', 'mhtml', 'one', 'pub', 'rtf']);
const NOTICE = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'z', 'cab', 'arj', 'ace', 'lz', 'lzh']);
// The ordinary document and media types a disguise borrows. Only these count as the
// fake half of a double extension, so a dotted date or version number in a name
// ("Statement 09.15.2026.html", "P&L v2.1.xlsm") is not reported as hidden. Same
// list as PRESENTATION_EXTENSIONS behind the backend's ATTACHMENT_DOUBLE_EXT rule.
const DECOY = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp',
  'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'mov', 'avi', 'wav']);

export function classifyAttachmentRisk(filename, mimeType = '') {
  const name = String(filename || '').trim().toLowerCase();
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts[parts.length - 1] : '';
  const prevExt = parts.length > 2 ? parts[parts.length - 2] : '';
  // ".pdf.exe": an innocent-looking extension right before the real one
  const disguised = (BLOCK.has(ext) || WARN.has(ext)) && DECOY.has(prevExt);
  const doubleExt = disguised ? `${prevExt}.${ext}` : null;

  const mime = String(mimeType || '').toLowerCase();
  if (BLOCK.has(ext) || /x-msdownload|x-msdos-program|x-sh\b|x-shellscript|java-archive|x-iso9660|vnd\.microsoft\.portable-executable/.test(mime)) {
    return { level: 'block', ext, doubleExt };
  }
  if (WARN.has(ext) || /macroenabled|text\/html|image\/svg/.test(mime)) {
    return { level: 'warn', ext, doubleExt };
  }
  if (NOTICE.has(ext) || /zip|x-rar|x-7z|x-tar|gzip|x-bzip/.test(mime)) {
    return { level: 'notice', ext, doubleExt };
  }
  return { level: 'ok', ext, doubleExt: null };
}
