// Electron 44 made the main-process clipboard asynchronous: clipboard.writeText()
// now returns a Promise. This helper awaits the write and reports whether it
// succeeded instead of letting a rejection go unhandled.
async function writeClipboardText(clipboard, text, logger = console) {
  try {
    await clipboard.writeText(String(text));
    return true;
  } catch (error) {
    logger.error('Could not write to the clipboard:', error);
    return false;
  }
}

module.exports = { writeClipboardText };
