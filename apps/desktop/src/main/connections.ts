import { randomUUID } from 'node:crypto';
import { paths } from './paths.js';
import { readJson, writeJson } from './store.js';

export type ConnectionKind = 'remote' | 'local';

export interface Connection {
  id: string;
  label: string;
  kind: ConnectionKind;
  /** Origin of the ParaDOCs server. Remote connections only. */
  url?: string;
}

interface ConnectionsFile {
  connections: Connection[];
  lastOpenedId?: string;
}

const empty: ConnectionsFile = { connections: [] };

function load(): ConnectionsFile {
  const file = readJson<ConnectionsFile>(paths.connectionsFile, empty);
  return { ...file, connections: Array.isArray(file.connections) ? file.connections : [] };
}

function save(file: ConnectionsFile): void {
  writeJson(paths.connectionsFile, file);
}

export function listConnections(): Connection[] {
  return load().connections;
}

export function getConnection(id: string): Connection | undefined {
  return load().connections.find((c) => c.id === id);
}

/**
 * Normalises what someone types into a server field. People paste
 * "docs.example.com", "docs.example.com/", or a full document URL; all three
 * should mean the same server.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter a server address.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" is not a valid server address.`);
  }
  if (!parsed.hostname) throw new Error(`"${input}" is not a valid server address.`);
  return parsed.origin;
}

export function addConnection(input: { label: string; kind: ConnectionKind; url?: string }): Connection {
  const file = load();
  const connection: Connection = {
    id: randomUUID(),
    label: input.label.trim() || (input.kind === 'local' ? 'Local workspace' : 'ParaDOCs'),
    kind: input.kind,
    ...(input.kind === 'remote' ? { url: normalizeServerUrl(input.url ?? '') } : {}),
  };
  file.connections.push(connection);
  save(file);
  return connection;
}

export function updateConnection(id: string, patch: { label?: string; url?: string }): Connection {
  const file = load();
  const connection = file.connections.find((c) => c.id === id);
  if (!connection) throw new Error('That connection no longer exists.');
  if (patch.label !== undefined) connection.label = patch.label.trim() || connection.label;
  if (patch.url !== undefined && connection.kind === 'remote') {
    connection.url = normalizeServerUrl(patch.url);
  }
  save(file);
  return connection;
}

export function removeConnection(id: string): void {
  const file = load();
  file.connections = file.connections.filter((c) => c.id !== id);
  if (file.lastOpenedId === id) delete file.lastOpenedId;
  save(file);
}

export function rememberLastOpened(id: string): void {
  const file = load();
  file.lastOpenedId = id;
  save(file);
}

export function lastOpened(): Connection | undefined {
  const file = load();
  return file.connections.find((c) => c.id === file.lastOpenedId);
}

/** Chromium keeps cookies per partition, so each server gets its own login. */
export function partitionFor(connection: Connection): string {
  return `persist:paradocs-${connection.id}`;
}
