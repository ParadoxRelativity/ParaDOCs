import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { documentSchema } from './documentSchema.js';

/**
 * Runs BlockNote's schema server side so a Y.Doc can be converted back into
 * blocks and markdown, and markdown into blocks. Creating it is expensive, so
 * there is exactly one, shared by the collaboration server and the MCP server.
 */
export const serverEditor = ServerBlockNoteEditor.create({ schema: documentSchema });
