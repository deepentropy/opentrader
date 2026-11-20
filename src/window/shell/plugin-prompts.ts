/*
 * Plugins' questions to the user (`plugin.prompt`, plugins/PROTOCOL.md): a login code, or a message while the plugin
 * waits for something done elsewhere (a login approved on a phone). Shown by the main window; the answer goes back to
 * the plugin, and a prompt closes when the plugin says it's done or disconnects.
 */
import { commands, events } from "../../bindings";
import { showAsk } from "../../components/Dialogs";

/** Starts listening; returns the stop. */
export function startPluginPrompts(): () => void {
  const open = new Map<string, { plugin: string; close: () => void }>();
  const keyOf = (plugin: string, id: string) => `${plugin}\n${id}`;
  const stops = [
    events.pluginPrompt.listen(({ payload: p }) => {
      const key = keyOf(p.plugin, p.id);
      open.get(key)?.close();
      const close = showAsk({
        title: p.title || p.pluginName,
        text: p.message,
        input: p.input === "text" || p.input === "password" ? p.input : null,
        imageSrc: p.image ? `data:image/png;base64,${p.image}` : null,
        onAnswer: (value) => {
          open.delete(key);
          if (p.input) void commands.pluginPromptAnswer(p.plugin, p.id, value);
        },
      });
      open.set(key, { plugin: p.plugin, close });
    }),
    events.pluginPromptDone.listen(({ payload: p }) => {
      const key = keyOf(p.plugin, p.id);
      open.get(key)?.close();
      open.delete(key);
    }),
    // A plugin that went away asks nothing any more.
    events.pluginsChanged.listen(() => {
      if (open.size === 0) return;
      void commands.pluginsStatus().then((s) => {
        const connected = new Set(s.plugins.filter((x) => x.connected).map((x) => x.manifest.id));
        for (const [key, o] of open) {
          if (!connected.has(o.plugin)) {
            o.close();
            open.delete(key);
          }
        }
      });
    }),
  ];
  return () => {
    for (const s of stops) void s.then((f) => f());
    for (const o of open.values()) o.close();
    open.clear();
  };
}
