/*
 * The composer's model and effort button, as the reference app's: the model's name and the effort in grey, a caret;
 * its menu lists the models (name, description), then "Effort ›" with its levels. Here the models are the user's, so
 * the menu ends with "Manage models…", and Effort has "Default" (the server's own; some models refuse the setting).
 */
import { For, Show, createSignal } from "solid-js";
import { Icon } from "../../components/Icon";
import { EFFORTS, config, selectModel, selectedModel, type Effort } from "../../data/assistant/models";
import { Popup } from "./Popup";

export function ModelPicker(props: { onManage: () => void }) {
  const [open, setOpen] = createSignal(false);
  const [effortOpen, setEffortOpen] = createSignal(false);
  const effort = () => (config().effort as Effort | null) ?? null;
  const effortLabel = () => EFFORTS.find((e) => e.id === effort())?.label ?? "Default";
  const close = () => {
    setOpen(false);
    setEffortOpen(false);
  };
  return (
    <div class="asst-picker-wrap">
      <button
        type="button"
        class="asst-picker"
        classList={{ "is-open": open() }}
        aria-haspopup="menu"
        aria-label={`Model and effort: ${selectedModel()?.label ?? "none"}, ${effortLabel()}`}
        onClick={() => (open() ? close() : setOpen(true))}
      >
        <span class="asst-picker-model">{selectedModel()?.label ?? "Add a model"}</span>
        <Show when={selectedModel()}>
          <span class="asst-picker-effort">{effortLabel()}</span>
        </Show>
        <span class="asst-caret" classList={{ "is-open": open() }}><Icon name="scr-caret-small" size={18} /></span>
      </button>
      <Show when={open()}>
        <Popup onClose={close} class="asst-picker-menu">
          <For each={config().models}>
            {(m) => (
              <button
                type="button"
                class="asst-model-item"
                classList={{ "is-selected": m.id === selectedModel()?.id }}
                role="menuitemradio"
                aria-checked={m.id === selectedModel()?.id}
                onClick={() => {
                  void selectModel(m.id, effort());
                  close();
                }}
              >
                <span class="asst-model-name">{m.label}</span>
                <Show when={m.description}><span class="asst-model-desc">{m.description}</span></Show>
              </button>
            )}
          </For>
          <div class="asst-menu-sep" />
          <div class="asst-effort-row" onMouseEnter={() => setEffortOpen(true)}>
            <button type="button" class="asst-menu-item asst-effort-btn" aria-haspopup="menu" onClick={() => setEffortOpen(true)}>
              <span>Effort</span>
              <span class="asst-muted">{effortLabel()} ›</span>
            </button>
            <Show when={effortOpen()}>
              <div class="asst-popup asst-effort-menu" role="menu">
                <div class="asst-menu-label">EFFORT</div>
                <For each={[{ id: null as Effort | null, label: "Default" }, ...EFFORTS]}>
                  {(e) => (
                    <button
                      type="button"
                      class="asst-menu-item"
                      classList={{ "is-selected": e.id === effort() }}
                      role="menuitemradio"
                      aria-checked={e.id === effort()}
                      onClick={() => {
                        void selectModel(null, e.id);
                        close();
                      }}
                    >
                      {e.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="asst-menu-sep" />
          <button
            type="button"
            class="asst-menu-item"
            onClick={() => {
              close();
              props.onManage();
            }}
          >
            Manage models…
          </button>
        </Popup>
      </Show>
    </div>
  );
}
