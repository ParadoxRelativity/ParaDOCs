import { Fragment } from "react";
import { useIsMobile } from "../../lib/mobile";
import { MODIFIER } from "../../lib/tabs";
import { Modal } from "../Modal";
import { Button } from "../ui";

/** One row: the key combinations that do it (any of them works), and what it does. */
type Row = { keys: string[][]; does: string };

const EDITING: Row[] = [
  { keys: [[MODIFIER, "Z"]], does: "Undo" },
  {
    keys: [
      [MODIFIER, "Shift", "Z"],
      [MODIFIER, "Y"],
    ],
    does: "Redo",
  },
  {
    keys: [
      [MODIFIER, "C"],
      [MODIFIER, "X"],
      [MODIFIER, "V"],
    ],
    does: "Copy, cut and paste",
  },
  { keys: [[MODIFIER, "D"]], does: "Duplicate the selection" },
  { keys: [[MODIFIER, "A"]], does: "Select everything on the slide" },
  { keys: [["Delete"], ["Backspace"]], does: "Delete the selection" },
  { keys: [["Arrows"]], does: "Nudge, with Shift by 10" },
  { keys: [["Enter"]], does: "Edit the selected element" },
  { keys: [["Esc"]], does: "Stop editing, then clear the selection" },
  {
    keys: [
      [MODIFIER, "]"],
      [MODIFIER, "["],
    ],
    does: "Bring forward, send backward",
  },
  {
    keys: [
      [MODIFIER, "Shift", "]"],
      [MODIFIER, "Shift", "["],
    ],
    does: "Bring to front, send to back",
  },
];

const SLIDES: Row[] = [
  { keys: [[MODIFIER, "M"]], does: "New slide" },
  { keys: [["Page Down"], ["Page Up"]], does: "Next or previous slide" },
  { keys: [["Arrows"]], does: "Next or previous slide, in the slide list" },
  { keys: [["Shift", "Click"]], does: "Select a run of slides" },
  {
    keys: [[MODIFIER, "Click"]],
    does: "Add or remove a slide from the selection",
  },
];

const PRESENTING: Row[] = [
  { keys: [["→"], ["Space"], ["N"], ["Enter"]], does: "Next" },
  { keys: [["←"], ["Shift", "Space"], ["P"], ["Backspace"]], does: "Previous" },
  { keys: [["Home"], ["End"]], does: "First or last slide" },
  { keys: [["1–9"], ["Enter"]], does: "Go to slide by number" },
  { keys: [["B"], ["."]], does: "Black screen" },
  { keys: [["W"], [","]], does: "White screen" },
  { keys: [["L"]], does: "Laser pointer" },
  { keys: [["F"]], does: "Full screen" },
  { keys: [["S"]], does: "Presenter view" },
  { keys: [["Esc"]], does: "End the show" },
];

/**
 * The keys the slides editor and the show answer to, opened with ? or the
 * toolbar's keyboard button. The lists follow the editor's key handler and
 * showCommandForKey; a change to either belongs here too.
 */
export default function SlideShortcutsDialog({
  canEdit,
  onClose,
}: {
  canEdit: boolean;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  return (
    <Modal
      title="Keyboard shortcuts"
      wide
      fullScreen={mobile}
      onClose={onClose}
      footer={
        <Button
          variant="subtle"
          autoFocus
          onClick={onClose}
          className="min-h-10 px-4"
        >
          Close
        </Button>
      }
    >
      <div className="scroll-thin max-h-[65vh] space-y-5 overflow-y-auto pr-1 text-sm">
        {canEdit && <Section title="Editing" rows={EDITING} />}
        <Section title="Slides" rows={canEdit ? SLIDES : SLIDES.slice(1)} />
        <Section title="Presenting" rows={PRESENTING} />
      </div>
    </Modal>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}
      </h3>
      <dl className="divide-y divide-[var(--color-line)]">
        {rows.map((row) => (
          <div
            key={row.does}
            className="flex items-center justify-between gap-4 py-1.5"
          >
            <dt>{row.does}</dt>
            <dd className="flex shrink-0 flex-wrap justify-end gap-x-2 gap-y-1">
              {row.keys.map((combo, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  {combo.map((key, j) => (
                    <Fragment key={j}>
                      {j > 0 && (
                        <span className="text-xs text-[var(--color-muted)]">
                          +
                        </span>
                      )}
                      <kbd className="min-w-6 rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1.5 py-0.5 text-center font-sans text-xs">
                        {key}
                      </kbd>
                    </Fragment>
                  ))}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
