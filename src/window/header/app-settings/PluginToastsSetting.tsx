/*
 * Settings > Plugins: where the plugins' toasts show.
 */
import { SelectControl } from "../../../components/form";
import { TOAST_CHOICES, setToastChoice, toastChoice, type ToastChoice } from "../../../data/plugin-toast-piles";
import { translate } from "../../../i18n/translator";
import { Section } from "./parts";

const label = (c: string): string => {
  switch (c as ToastChoice) {
    case "plugin": return translate("Where the plugin asks");
    case "top-left": return translate("Top left");
    case "top-center": return translate("Top center");
    case "top-right": return translate("Top right");
    case "bottom-left": return translate("Bottom left");
    case "bottom-center": return translate("Bottom center");
    case "bottom-right": return translate("Bottom right");
    case "off": return translate("Don't show");
  }
};

export function PluginToastsSetting() {
  return (
    <Section label="PLUGIN MESSAGES">
      <SelectControl value={toastChoice()} options={TOAST_CHOICES} labelOf={label} width={467} onPick={(v) => setToastChoice(v as ToastChoice)} />
    </Section>
  );
}
