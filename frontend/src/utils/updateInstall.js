// Shared "Copy & Quit" action for manual (Linux package) updates. The Electron
// main process copies the install command and quits, but the clipboard write can
// fail and then returns { copied: false } without quitting, so the user must be told.
export async function copyInstallCommandAndQuitOrWarn(updates, { installCommand, filePath } = {}, addNotification) {
  const result = await updates?.copyInstallCommandAndQuit?.({ installCommand, filePath });
  if (!result?.copied) {
    addNotification({
      type: 'error',
      title: 'Copy failed',
      body: 'The update command could not be copied.',
    });
  }
  return result;
}
