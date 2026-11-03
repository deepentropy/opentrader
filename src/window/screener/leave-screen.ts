/*
 * Leaving a screen with unsaved changes (opening another screen, a popular
 * screen, a new one) asks first, as the reference app does: "Save changes?"
 * with "Don't save" (go on, the changes are dropped) and "Save" (saved in
 * place, or under a name asked for a screen never saved, then go on); the
 * close button stays on the screen.
 */
import { showConfirm, showRename } from "../../components/Dialogs";
import { screenerStore } from "../../data/screener-store";

export function leaveScreen(then: () => void): void {
  if (!screenerStore.unsaved()) {
    then();
    return;
  }
  showConfirm({
    title: "Save changes?",
    text: "You'll lose unsaved changes in your current screen if you continue without saving.",
    mainText: "Save",
    cancelText: "Don't save",
    intent: "neutral",
    onConfirm: () => {
      if (screenerStore.save()) {
        then();
        return;
      }
      showRename({
        title: "Save screen as",
        label: "New screen name",
        maxLength: 64,
        names: screenerStore.savedScreens().map((s) => s.screen.title),
        replaceText: (name) => `"${name}" already exists. Replace it?`,
        initialValue: screenerStore.screen().title,
        onSave: (name) => {
          const same = screenerStore.savedScreens().find((s) => s.screen.title === name);
          if (same) screenerStore.remove(same.id);
          screenerStore.saveAs(name);
          then();
        },
      });
    },
    onCancel: then,
    onDismiss: () => {},
  });
}
