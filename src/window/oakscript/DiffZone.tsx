/*
 * Header of the inline diff of one changed block (#325, diff decorations), as the reference's: the pointer under the
 * gutter mark, "Local working changes", then Discard changes and Close. The diff itself is a Monaco diff editor in
 * the `editorHost` element below the header (diff-decorations.ts).
 */
import { Icon } from "../../components/Icon";
import { Tooltip } from "../../components/Tooltip";
import { translateAs } from "../../i18n/translator";
import type { DiffKind } from "./line-diff";

type Props = {
  kind: DiffKind;
  /** Left of the pointer, px from the zone's left edge (under the gutter mark). */
  arrowLeft: number;
  onDiscard: () => void;
  onClose: () => void;
  editorHost: (el: HTMLDivElement) => void;
};

export function DiffZone(props: Props) {
  return (
    <div class={`oak-diff-zone oak-diff-zone--${props.kind}`} data-qa-id="oakscript-inline-diff">
      <div class="oak-diff-zone__arrow" style={{ "inset-inline-start": `${props.arrowLeft}px` }} />
      <div class="oak-diff-zone__header">
        <div class="oak-diff-zone__title">Local working changes</div>
        <div class="oak-diff-zone__actions">
          <Tooltip text="Discard changes" side="top">
            <button type="button" class="oak-diff-zone__action" aria-label="Discard changes" data-name="button-discard-changes" onClick={() => props.onDiscard()}>
              <Icon name="oak-diff-discard" size={18} />
            </button>
          </Tooltip>
          <Tooltip text={translateAs("Close", "action")} side="top">
            <button type="button" class="oak-diff-zone__action" aria-label="Close" data-name="button-close-diff" onClick={() => props.onClose()}>
              <Icon name="tab-close" size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div class="oak-diff-zone__editor" ref={props.editorHost} />
    </div>
  );
}
