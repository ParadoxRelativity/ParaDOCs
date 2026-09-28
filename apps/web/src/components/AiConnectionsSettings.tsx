import { useState } from 'react';
import { MCP_PATH, type AiConnection, type CreatedAiKey } from '@paradocs/shared';
import { useAiConnectionActions, useAiConnections, useWorkspaces } from '../api/hooks';
import { serverUrl } from '../lib/server';
import { cx, formatRelative } from '../lib/util';
import Icon from './Icon';
import { ConfirmDialog, Modal } from './Modal';
import { FIELD, FIELD_BASE, Section } from './SettingsParts';
import { useToast } from './Toast';
import { Button, IconButton } from './ui';

/** The MCP server's full address, as an assistant outside would reach it. */
function mcpUrl(): string {
  return new URL(serverUrl(MCP_PATH), window.location.href).href;
}

async function copy(text: string, what: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    // Clipboard needs a secure context; the text is on screen to copy by hand.
    toast('Could not copy. Select it and copy it by hand.', 'error');
  }
}

function Snippet({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <div className="flex items-start gap-1">
      <pre className="scroll-thin min-w-0 flex-1 overflow-x-auto rounded bg-[var(--color-surface)] p-2 font-mono text-xs">{text}</pre>
      <IconButton label={`Copy ${label}`} onClick={() => void copy(text, label, toast)}>
        <Icon name="clipboard" />
      </IconButton>
    </div>
  );
}

/**
 * Connecting AI assistants — Claude, ChatGPT, Cursor and the like — to
 * ParaDOCs through its MCP server. An assistant either signs in through the
 * browser, as claude.ai and ChatGPT do, or is given a key made here. Either
 * way it acts as you, can be held to one workspace and to reading, and is
 * listed here to revoke.
 */
export default function AiConnectionsSettings() {
  const connections = useAiConnections();
  const actions = useAiConnectionActions();
  const workspaces = useWorkspaces();
  const toast = useToast();
  const [name, setName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [canWrite, setCanWrite] = useState(false);
  const [created, setCreated] = useState<CreatedAiKey | null>(null);
  const [revoking, setRevoking] = useState<AiConnection | null>(null);
  const enabled = connections.data?.enabled ?? false;
  const list = connections.data?.connections ?? [];
  const url = mcpUrl();

  function makeKey(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    actions.createKey.mutate(
      { name: name.trim(), workspaceId: workspaceId || null, canWrite },
      {
        onSuccess: (key) => {
          setName('');
          setCreated(key);
        },
        onError: (err) => toast(err instanceof Error ? err.message : 'Could not make the key', 'error'),
      },
    );
  }

  if (connections.isLoading) return null;

  return (
    <>
      {!enabled && (
        <p className="mb-4 rounded-md border border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-muted)]">
          AI connections are turned off on this server. A server administrator can turn them on in the server settings.
          {list.length > 0 && ' Your connections below do nothing until then.'}
        </p>
      )}

      {enabled && (
        <>
          <Section
            title="Connect an assistant"
            hint="Assistants reach ParaDOCs through its MCP server. They act as you and see only what you can."
          >
            <div className="mb-3 flex items-center gap-2 text-xs">
              <span className="shrink-0 text-[var(--color-muted)]">MCP server</span>
              <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface)] px-2 py-1">{url}</code>
              <IconButton label="Copy MCP server address" onClick={() => void copy(url, 'Address', toast)}>
                <Icon name="clipboard" />
              </IconButton>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <p className="font-medium">Claude, ChatGPT and other apps that sign in</p>
                <p className="mt-0.5 text-[var(--color-muted)]">
                  Add a custom connector with the address above. In Claude it is under Settings → Connectors, and works
                  on a subscription plan with no API key. You are sent here to sign in and choose what it may reach.
                </p>
              </div>
              <div>
                <p className="mb-1 font-medium">Claude Code</p>
                <Snippet label="Command" text={`claude mcp add --transport http paradocs ${url}`} />
                <p className="mt-1 text-[var(--color-muted)]">
                  Then run <code>/mcp</code> in Claude Code to sign in. Or make a key below and add it with{' '}
                  <code>--header</code>. Once connected, <code>/mcp__paradocs__work_on_item ENG-12</code> pulls an item
                  off a board into the session.
                </p>
              </div>
            </div>
          </Section>

          <Section
            title="Make a key"
            hint="For clients that take a key rather than signing in, or for scripts. Bring your own key: it is shown once, and only its hash is kept."
          >
            <form onSubmit={makeKey} className="space-y-2">
              <input
                className={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name it after what will use it, such as Claude Code on my laptop"
                maxLength={80}
              />
              <div className="flex flex-wrap gap-2">
                <select
                  className={cx(FIELD_BASE, 'min-w-0 flex-1')}
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  aria-label="Workspaces it can reach"
                >
                  <option value="">Every workspace</option>
                  {(workspaces.data ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      Only {w.name}
                    </option>
                  ))}
                </select>
                <select
                  className={cx(FIELD_BASE, 'min-w-0 flex-1')}
                  value={canWrite ? 'write' : 'read'}
                  onChange={(e) => setCanWrite(e.target.value === 'write')}
                  aria-label="What it can do"
                >
                  <option value="read">Read only</option>
                  <option value="write">Read and change</option>
                </select>
                <Button
                  variant="primary"
                  type="submit"
                  className="text-xs"
                  disabled={!name.trim() || actions.createKey.isPending}
                >
                  Make key
                </Button>
              </div>
            </form>
          </Section>
        </>
      )}

      <Section title="Your connections" hint="Keys you made, and assistants you signed in. Revoking one stops it at once.">
        <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
          {list.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-2 py-1.5">
              <Icon name={c.kind === 'key' ? 'key' : 'robot'} className="w-5 text-center text-[var(--color-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{c.name}</span>
                <span className="block text-xs text-[var(--color-muted)]">
                  {c.kind === 'key' ? `Key …${c.hint}` : 'Signed in'} · {c.workspace ? `only ${c.workspace.name}` : 'every workspace'} ·{' '}
                  {c.canWrite ? 'read and change' : 'read only'} ·{' '}
                  {c.lastUsedAt ? `used ${formatRelative(c.lastUsedAt)}` : 'not used yet'}
                </span>
              </span>
              <IconButton label={`Revoke ${c.name}`} onClick={() => setRevoking(c)}>
                <Icon name="trash3" />
              </IconButton>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No connections yet.</li>}
        </ul>
      </Section>

      {created && <CreatedKeyDialog aiKey={created} url={url} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          description="The assistant using it is refused from now on. Anything it already did is kept."
          confirmLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const id = revoking.id;
            setRevoking(null);
            actions.revoke.mutate(id, {
              onError: (err) => toast(err instanceof Error ? err.message : 'Could not revoke it', 'error'),
            });
          }}
        />
      )}
    </>
  );
}

/** The new key, shown the one time it can be, with how to use it. */
function CreatedKeyDialog({ aiKey, url, onClose }: { aiKey: CreatedAiKey; url: string; onClose: () => void }) {
  const claudeCode = `claude mcp add --transport http paradocs ${url} \\\n  --header "Authorization: Bearer ${aiKey.key}"`;
  const json = JSON.stringify(
    { mcpServers: { paradocs: { type: 'http', url, headers: { Authorization: `Bearer ${aiKey.key}` } } } },
    null,
    2,
  );
  return (
    <Modal
      title={`${aiKey.name} is ready`}
      description="Copy the key now. It is not shown again; if it is lost, revoke it and make another."
      onClose={onClose}
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3 text-xs">
        <Snippet label="Key" text={aiKey.key} />
        <div>
          <p className="mb-1 font-medium">Claude Code</p>
          <Snippet label="Command" text={claudeCode} />
        </div>
        <div>
          <p className="mb-1 font-medium">Cursor, VS Code and other clients that read an MCP config file</p>
          <Snippet label="Config" text={json} />
        </div>
        <p className="text-[var(--color-muted)]">
          Anyone with this key can {aiKey.canWrite ? 'read and change' : 'read'}{' '}
          {aiKey.workspace ? `the ${aiKey.workspace.name} workspace` : 'every workspace you are in'} as you. Keep it out of
          code you commit.
        </p>
      </div>
    </Modal>
  );
}
