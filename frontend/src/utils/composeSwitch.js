// A save owns the exact editor snapshot it wrote. A newer edit remains dirty until another
// successful save; concurrent autosave, manual save, and selection handoff share one writer.
export function createComposeSwitch({ snapshot, save, unsupported = () => false }) {
  let saved;
  let inFlight = null;
  const current = () => JSON.stringify(snapshot());
  const isDirty = () => current() !== saved;
  const markSaved = (value) => { saved = value === undefined ? current() : JSON.stringify(value); };

  const saveCurrent = ({ force = false, allowUnsupported = false } = {}) => {
    if (inFlight) return inFlight;
    if (!force && !isDirty()) return Promise.resolve(true);
    if (!allowUnsupported && unsupported()) return Promise.resolve(false);
    const work = (async () => {
      try {
        while (force || isDirty()) {
          force = false;
          if (!allowUnsupported && unsupported()) return false;
          const value = snapshot();
          const serialized = JSON.stringify(value);
          if (!(await save(value))) return false;
          saved = serialized;
        }
        return true;
      } catch {
        return false;
      }
    })();
    inFlight = work;
    work.finally(() => { if (inFlight === work) inFlight = null; });
    return work;
  };

  const prepare = () => unsupported() && isDirty() ? Promise.resolve(false) : saveCurrent();
  return { markSaved, isDirty, save: saveCurrent, prepare,
    waitForIdle: () => inFlight || Promise.resolve(true),
    isSaving: () => Boolean(inFlight) };
}
