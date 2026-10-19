import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { claimImport, applyImport } from '../../lib/slideImport';
import { describeReportItem, type ImportReportItem } from '../../lib/slideImportTypes';
import { useIsMobile } from '../../lib/mobile';
import { cx } from '../../lib/util';
import { Modal } from '../Modal';
import { useToast } from '../Toast';
import { Button } from '../ui';
import Icon from '../Icon';

/**
 * The other half of importing a presentation: a deck made from a file arrives
 * empty, with the file's contents waiting in lib/slideImport. The first time the
 * editor opens it, they are written in (one transaction, so one undo step), and
 * the import report is shown: everything that was approximated or left out, so
 * nothing disappears unannounced.
 */
export default function SlideImportHost({ presentationId, ydoc, canEdit }: { presentationId: string; ydoc: Y.Doc; canEdit: boolean }) {
  const toast = useToast();
  const [report, setReport] = useState<{ fileName: string; slides: number; items: ImportReportItem[] } | null>(null);

  useEffect(() => {
    // Claiming consumes it, so this runs once per imported presentation.
    const deck = claimImport(presentationId);
    if (!deck || !canEdit) return;
    try {
      const { slideIds } = applyImport(ydoc, deck);
      setReport({ fileName: deck.fileName, slides: slideIds.length, items: deck.report.items });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not add the imported slides', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentationId]);

  if (!report) return null;
  return <ImportReportDialog report={report} onClose={() => setReport(null)} />;
}

export function ImportReportDialog({
  report,
  onClose,
}: {
  report: { fileName: string; slides: number; items: ImportReportItem[] };
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  const dropped = report.items.filter((item) => item.kind === 'dropped');
  const approximated = report.items.filter((item) => item.kind === 'approximated');
  return (
    <Modal
      title="Import report"
      description={`Imported ${report.slides} slide${report.slides === 1 ? '' : 's'} from ${report.fileName}.`}
      onClose={onClose}
      fullScreen={mobile}
      footer={
        <Button variant="primary" onClick={onClose} className="min-h-10 px-4">
          Done
        </Button>
      }
    >
      {report.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Icon name="check-circle" /> Everything came across.
        </p>
      ) : (
        <div className="scroll-thin max-h-[60vh] space-y-4 overflow-y-auto text-sm">
          <ReportSection title="Left out" icon="x-circle" items={dropped} tone="text-red-500" />
          <ReportSection title="Approximated" icon="exclamation-triangle" items={approximated} tone="text-amber-500" />
        </div>
      )}
    </Modal>
  );
}

function ReportSection({ title, icon, items, tone }: { title: string; icon: 'x-circle' | 'exclamation-triangle'; items: ImportReportItem[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        <Icon name={icon} className={cx(tone)} /> {title} ({items.length})
      </h3>
      <ul className="list-disc space-y-1 pl-5">
        {items.map((item) => (
          <li key={`${item.kind}:${item.feature}`}>{describeReportItem(item)}</li>
        ))}
      </ul>
    </section>
  );
}
