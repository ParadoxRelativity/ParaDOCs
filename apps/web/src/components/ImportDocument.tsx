import { useRef, useState } from 'react';
import { useCreateDocument } from '../api/hooks';
import { DOCUMENT_IMPORT_ACCEPT, readDocumentFile, rememberDocumentImport } from '../lib/documentImport';
import { useToast } from './Toast';

/**
 * Making a document from a Markdown, HTML or Word file. Returns the hidden
 * file input to render and the function that opens it, so any button can
 * offer it.
 */
export function useDocumentImport(workspaceId: string, onOpen: (documentId: string) => void) {
  const create = useCreateDocument(workspaceId);
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    setImporting(true);
    try {
      const imported = await readDocumentFile(file);
      // Unfiled, as a new document is; it gets a folder when someone picks one.
      const doc = await create.mutateAsync({ title: imported.title, folderId: null });
      rememberDocumentImport(doc.id, imported);
      onOpen(doc.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not import that file', 'error');
    } finally {
      setImporting(false);
    }
  }

  const input = (
    <input
      ref={fileInput}
      type="file"
      accept={DOCUMENT_IMPORT_ACCEPT}
      className="hidden"
      aria-label="Markdown, HTML or Word file to import"
      onChange={(event) => {
        const file = event.target.files?.[0];
        // Cleared so choosing the same file again still fires a change.
        event.target.value = '';
        if (file) void importFile(file);
      }}
    />
  );

  // One file at a time; asking again while one is being read does nothing.
  const choose = () => {
    if (!importing) fileInput.current?.click();
  };
  return { importing, choose, input };
}
