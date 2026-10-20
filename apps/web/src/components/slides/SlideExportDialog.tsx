import { useState } from 'react';
import type { DeckSnapshot } from '@paradocs/shared';
import { downloadPptx, fetchDeckForExport } from '../../lib/slidesExport';
import { HANDOUT_COUNTS, type PdfLayout } from '../../lib/slidesExport/printLayout';
import { isNativeApp } from '../../lib/server';
import { cx } from '../../lib/util';
import Icon, { type IconName } from '../Icon';
import { Modal } from '../Modal';
import { FIELD } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button } from '../ui';
import SlidePrintJob from './SlidePrintJob';

type Format = 'pptx' | 'pdf';

const FORMATS: { id: Format; icon: IconName; label: string; hint: string }[] = [
  { id: 'pptx', icon: 'filetype-pptx', label: 'PowerPoint (.pptx)', hint: 'Editable: theme, layouts, notes, transitions and animations' },
  { id: 'pdf', icon: 'filetype-pdf', label: 'PDF', hint: 'One page per slide, text you can select and search' },
];

/** The PDF layouts as the select offers them. */
const LAYOUTS: { value: string; label: string; layout: PdfLayout }[] = [
  { value: 'slides', label: 'Slides, one per page', layout: { kind: 'slides' } },
  { value: 'notes', label: 'Notes pages', layout: { kind: 'notes' } },
  ...HANDOUT_COUNTS.map((perPage) => ({ value: `handout-${perPage}`, label: `Handouts, ${perPage} per page`, layout: { kind: 'handout', perPage } as PdfLayout })),
];

/**
 * Takes a presentation out as a PowerPoint file or a PDF. It reads the deck as
 * the person asking, so a viewer can export whatever they can open and nothing
 * more. The editor hands over the deck it has open; the presentation list does
 * not, and the deck is fetched when the export starts.
 */
export default function SlideExportDialog({
  presentationId,
  title,
  deck,
  initialFormat = 'pptx',
  onClose,
}: {
  presentationId: string;
  title: string;
  deck?: DeckSnapshot;
  initialFormat?: Format;
  onClose: () => void;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<Format>(initialFormat);
  const [layoutKey, setLayoutKey] = useState('slides');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{ filename: string; notes: string[] } | null>(null);
  const [printing, setPrinting] = useState<{ deck: DeckSnapshot; layout: PdfLayout } | null>(null);

  // A phone's web view cannot print, so PDF is offered where the browser can.
  const pdfAvailable = !isNativeApp;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const source = deck ?? (await fetchDeckForExport(presentationId));
      if (format === 'pptx') {
        const result = await downloadPptx(source, title);
        if (result.report.length === 0) {
          toast(`Exported ${result.filename}`);
          onClose();
        } else {
          setReport({ filename: result.filename, notes: result.report });
        }
      } else {
        setPrinting({ deck: source, layout: LAYOUTS.find((l) => l.value === layoutKey)!.layout });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export the presentation');
    } finally {
      setBusy(false);
    }
  }

  if (printing) {
    return (
      <SlidePrintJob
        deck={printing.deck}
        title={title}
        layout={printing.layout}
        onDone={() => {
          setPrinting(null);
          onClose();
        }}
      />
    );
  }

  if (report) {
    return (
      <Modal
        title={`Exported ${report.filename}`}
        description="Saved to your downloads. A few things are carried over differently:"
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-muted)]">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      title="Export presentation"
      description={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" className="text-xs" disabled={busy || (format === 'pdf' && !pdfAvailable)} onClick={() => void run()}>
            {busy ? 'Exporting…' : format === 'pdf' ? 'Continue to print' : 'Export'}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label="Format" className="space-y-2">
        {FORMATS.map((option) => {
          const unavailable = option.id === 'pdf' && !pdfAvailable;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={format === option.id}
              disabled={unavailable || busy}
              onClick={() => setFormat(option.id)}
              className={cx(
                'flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50',
                format === option.id ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-line)] hover:bg-[var(--color-surface)]',
              )}
            >
              <span className="text-xl text-[var(--color-muted)]">
                <Icon name={option.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-[var(--color-muted)]">{unavailable ? 'Not available in the mobile app. Export PowerPoint, or use ParaDOCs in a browser.' : option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {format === 'pdf' && pdfAvailable && (
        <label className="mt-3 block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Layout</span>
          <select className={FIELD} value={layoutKey} onChange={(e) => setLayoutKey(e.target.value)} disabled={busy}>
            {LAYOUTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-[var(--color-muted)]">Choose “Save as PDF” in the print window that opens. Hidden slides are left out.</span>
        </label>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-500">
          {error}
        </p>
      )}
    </Modal>
  );
}
