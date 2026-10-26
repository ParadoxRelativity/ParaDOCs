import { useIsMobile } from '../../lib/mobile';
import { isKeynoteFile } from '../../lib/slideConvert';
import { Modal } from '../Modal';
import { Button } from '../ui';

/**
 * Shown when someone chooses a .ppt or Keynote file and the server has no
 * converter (or, in a desktop local workspace, there is no server at all). It
 * says what the format needs and what works instead, rather than failing: PDF
 * import needs nothing, and so does exporting to .pptx from the original app.
 */
export default function ConverterNeededDialog({
  fileNames,
  onPickPdf,
  onClose,
}: {
  fileNames: string[];
  /** Opens the file chooser for a PDF of the same deck. */
  onPickPdf: () => void;
  onClose: () => void;
}) {
  const mobile = useIsMobile();
  const keynote = fileNames.some(isKeynoteFile);
  return (
    <Modal
      title="This format needs the server converter"
      onClose={onClose}
      fullScreen={mobile}
      footer={
        <>
          <Button variant="subtle" onClick={onClose} className="min-h-10 px-4">
            Cancel
          </Button>
          <Button
            variant="primary"
            className="min-h-10 px-4"
            onClick={() => {
              onClose();
              onPickPdf();
            }}
          >
            Import a PDF instead
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          {fileNames.length === 1 ? <strong className="break-all">{fileNames[0]}</strong> : `${fileNames.length} of those files`} can only be imported through a
          converter, which this server does not have. Older PowerPoint (.ppt) and Keynote (.key) files are read by LibreOffice on the server, and in a desktop
          local workspace there is no server to do that.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            {keynote ? 'In Keynote, choose File > Export To > PowerPoint, then import the .pptx.' : 'In PowerPoint, save the file as .pptx, then import that.'}
          </li>
          <li>Or export the deck to PDF and import that. Each page becomes a picture slide that looks just like the original.</li>
          <li>To convert these files in ParaDOCs, ask whoever runs the server to turn on the converter.</li>
        </ul>
      </div>
    </Modal>
  );
}
