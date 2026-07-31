function selectKey(spec, platform) {
  if (!spec) return null;
  if (typeof spec === 'string') return spec;
  return spec[platform] || spec.default || null;
}

export function effectiveCommandKeys(command, context) {
  const hasOverride = Object.hasOwn(context.shortcutOverrides, command.id);
  const override = hasOverride ? context.shortcutOverrides[command.id] : undefined;
  const bindings = [];
  const primary = hasOverride ? override : selectKey(command.defaultKeys.primary, context.platform);
  if (primary) bindings.push({ key: primary, kind: hasOverride ? 'user' : 'primary' });
  for (const spec of command.defaultKeys.secondary) {
    const key = selectKey(spec, context.platform);
    if (key && !bindings.some(binding => binding.key === key)) bindings.push({ key, kind: 'secondary' });
  }
  return { bindings, conflicts: [] };
}

export function formatCommandKey(key, platform) {
  const mac = platform === 'mac';
  const labels = mac
    ? { meta: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧', enter: '↵' }
    : { meta: 'Win+', ctrl: 'Ctrl+', alt: 'Alt+', shift: 'Shift+', enter: 'Enter' };
  return key.split('+').map((part, index, all) => {
    const normalized = part.toLowerCase();
    const label = labels[normalized] || (part.length === 1 ? part.toUpperCase() : part);
    return mac || index === all.length - 1 ? label : label;
  }).join(mac ? '' : '');
}

export function findBindingConflicts(commands, context) {
  const owners = new Map();
  for (const command of commands) {
    for (const { key } of effectiveCommandKeys(command, context).bindings) {
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(command.id);
    }
  }
  return [...owners.entries()]
    .filter(([, commandIds]) => commandIds.length > 1)
    .map(([key, commandIds]) => ({ key, commandIds }));
}
