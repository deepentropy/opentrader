/*
 * Community website: stand-in for src/bindings.ts (the desktop app's commands). The website never reaches them; the
 * modules it shares with the app only import the names.
 */
const reject = (name: string) => () => Promise.reject(new Error(`${name} is not available on the website`));

export const commands: Record<string, (...args: unknown[]) => Promise<never>> = new Proxy({}, { get: (_t, name) => reject(String(name)) });

export const events: Record<string, { listen: () => Promise<() => void>; emit: () => Promise<void> }> = new Proxy(
  {},
  { get: () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }) },
);
