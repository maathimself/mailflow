import { createContext, useContext } from 'react';

const CommandRuntimeContext = createContext(null);

export function CommandRuntimeProvider({ runtime, children }) {
  return <CommandRuntimeContext.Provider value={runtime}>{children}</CommandRuntimeContext.Provider>;
}

export function useCommandRuntimeContext() {
  const runtime = useContext(CommandRuntimeContext);
  if (!runtime) throw new Error('useCommandRuntimeContext must be used inside CommandRuntimeProvider');
  return runtime;
}
