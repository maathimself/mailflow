// Attachment file extensions by risk tier. This is the canonical list. The message pane's download
// warning keeps a bundled copy in frontend/src/utils/attachmentExtensions.js, because the frontend image
// flattens frontend/ into /app and cannot import from here; attachmentExtensions.test.js fails CI when
// the two differ.
//
//   BLOCK  — run code, install something or hand over the machine when opened
//   WARN   — can carry active content (macros, HTML or SVG login pages) the user has to enable or open
//   NOTICE — archives, whose contents nothing here inspects
//   DECOY  — ordinary document and media types a disguise borrows ("invoice.pdf.exe"); only these count
//            as the fake half, so a dotted date or version number in a name is not taken for one
//
// Antispam scores BLOCK as ATTACHMENT_EXECUTABLE (and its attachment_is_executable flag), WARN as the
// lighter ATTACHMENT_ACTIVE_CONTENT, and reads BLOCK and DECOY for ATTACHMENT_DOUBLE_EXT (#457).

export const BLOCK = new Set(['exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh',
  'msi', 'msp', 'mst', 'jar', 'hta', 'cpl', 'reg', 'lnk', 'iso', 'img', 'vhd', 'vhdx', 'dll', 'apk', 'application', 'appx',
  'sh', 'run', 'dmg', 'pkg', 'deb', 'rpm', 'chm', 'inf', 'scf', 'url', 'ade', 'adp', 'gadget', 'ws',
  'msc', 'xll', 'py', 'pyw', 'pyz', 'pyzw', 'pyc', 'pyo', 'pl', 'ksh', 'csh', 'jnlp', 'app', 'appref-ms', 'msu',
  'diagcab', 'sct', 'wsc', 'settingcontent-ms', 'search-ms', 'library-ms', 'website', 'rdp']);

export const WARN = new Set(['docm', 'xlsm', 'xlsb', 'pptm', 'xlam', 'dotm', 'xltm', 'potm', 'ppam', 'sldm', 'html', 'htm',
  'shtml', 'xhtml', 'svg', 'mht', 'mhtml', 'one', 'pub', 'rtf']);

export const NOTICE = new Set(['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'z', 'cab', 'arj', 'ace', 'lz', 'lzh']);

export const DECOY = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp',
  'jpg', 'jpeg', 'png', 'gif', 'mp3', 'mp4', 'mov', 'avi', 'wav']);

// The files to judge: each attachment plus, for a forwarded message attached as an .eml, the files
// inside it (walkStructure records them as `contains`). Without this, wrapping a program in a
// forward hid it from every attachment rule, since the list itself only shows the .eml.
export function attachmentsWithContained(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.flatMap(a => [a, ...(Array.isArray(a?.contains) ? a.contains : [])]);
}
