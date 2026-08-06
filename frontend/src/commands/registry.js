import { validateCommandDefinition } from './contracts.js';
import { hasTargets } from './targets.js';
import { rankCommands } from './search.js';
import { effectiveCommandKeys } from './shortcuts.js';

export function createCommandRegistry(definitions) {
  const ordered = [];
  const byId = new Map();
  for (const input of definitions) {
    const command = validateCommandDefinition(input);
    if (byId.has(command.id)) throw new TypeError(`duplicate command id "${command.id}"`);
    ordered.push(command);
    byId.set(command.id, command);
  }
  Object.freeze(ordered);

  const available = context => ordered.filter(command => command.isAvailable(context) && hasTargets(command, context));
  const decorate = (results, context) => results.map(result => ({
    ...result,
    bindings: effectiveCommandKeys(result.command, context).bindings,
  }));

  return Object.freeze({
    get(id) {
      return byId.get(id) || null;
    },
    list(context) {
      return decorate(rankCommands(available(context), '', context), context);
    },
    search(query, context) {
      return decorate(rankCommands(available(context), query, context), context);
    },
  });
}
