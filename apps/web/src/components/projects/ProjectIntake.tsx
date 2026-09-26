import { useState } from 'react';
import { INTAKE_FIELDS, INTAKE_PATH, type CreatedIntakeToken, type IntakeToken, type Project } from '@paradocs/shared';
import { useIntake, useIntakeTokens } from '../../api/hooks';
import { serverUrl } from '../../lib/server';
import { cx, formatRelative } from '../../lib/util';
import Icon from '../Icon';
import { ConfirmDialog, Modal } from '../Modal';
import { FIELD, FIELD_BASE, Section } from '../SettingsParts';
import { useToast } from '../Toast';
import { Button, IconButton } from '../ui';

/** The webhook's full address, as a sender outside would post to it. */
function webhookUrl(): string {
  return new URL(serverUrl(INTAKE_PATH), window.location.href).href;
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

/**
 * A queue's intake tokens: keys a web form or another system sends work in
 * with, through the server's one intake webhook. Each token files what comes
 * in here, as the type it is set to, and can be revoked on its own. The whole
 * thing is off until a server administrator turns the webhook on.
 */
export default function IntakeSection({ project }: { project: Project }) {
  const intake = useIntake(project.id);
  const tokens = useIntakeTokens(project.id);
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [created, setCreated] = useState<CreatedIntakeToken | null>(null);
  const [revoking, setRevoking] = useState<IntakeToken | null>(null);
  const fail = (fallback: string) => (err: unknown) => toast(err instanceof Error ? err.message : fallback, 'error');
  const types = project.itemTypes.filter((t) => !t.epic);
  const enabled = intake.data?.enabled ?? false;
  const list = intake.data?.tokens ?? [];

  function add() {
    const name = newName.trim();
    if (!name) return;
    tokens.create.mutate(
      { name },
      {
        onSuccess: (token) => {
          setNewName('');
          setCreated(token);
        },
        onError: fail('Could not make the token'),
      },
    );
  }

  return (
    <Section
      title="Intake"
      hint="Let a web form or another system file requests here. Each token sends work into this queue only, and can be revoked on its own. Name it after what will use it."
    >
      {intake.isLoading ? null : !enabled ? (
        <p className="rounded-md border border-[var(--color-line)] px-3 py-2 text-xs text-[var(--color-muted)]">
          Taking in work from outside is turned off on this server. A server administrator can turn on the intake
          webhook in the server settings.
          {list.length > 0 && ` This queue's ${list.length === 1 ? 'token does' : `${list.length} tokens do`} nothing until then.`}
        </p>
      ) : (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="shrink-0 text-[var(--color-muted)]">Webhook</span>
          <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface)] px-2 py-1">POST {webhookUrl()}</code>
          <IconButton label="Copy webhook address" onClick={() => void copy(webhookUrl(), 'Webhook address', toast)}>
            <Icon name="clipboard" />
          </IconButton>
        </div>
      )}

      {(enabled || list.length > 0) && (
        <ul className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
          {list.map((token) => (
            <li key={token.id} className="flex items-center gap-2 px-2 py-1.5">
              <Icon name="key" className="w-5 text-center text-[var(--color-muted)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{token.name}</span>
                <span className="block text-xs text-[var(--color-muted)]">
                  …{token.hint} ·{' '}
                  {token.lastUsedAt
                    ? `${token.useCount} sent in, last ${formatRelative(token.lastUsedAt)}`
                    : 'Not used yet'}
                </span>
              </span>
              <select
                value={token.typeId ?? ''}
                aria-label={`Type work from ${token.name} is filed as`}
                onChange={(e) =>
                  tokens.update.mutate({ id: token.id, typeId: e.target.value || null }, { onError: fail('Could not change the token') })
                }
                className={cx(FIELD_BASE, 'w-36 shrink-0 py-1 text-xs')}
              >
                <option value="">Default type</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <IconButton label="Revoke token" onClick={() => setRevoking(token)}>
                <Icon name="trash3" />
              </IconButton>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-muted)]">No tokens yet.</li>}
          {enabled && (
            <li className="flex items-center gap-2 px-2 py-1.5">
              <Icon name="plus-lg" className="w-5 text-center text-[var(--color-muted)]" />
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && add()}
                placeholder="New token, such as Support form"
                maxLength={80}
                className={cx(FIELD, 'min-w-0 flex-1 py-1')}
              />
              <Button variant="subtle" className="text-xs" disabled={!newName.trim() || tokens.create.isPending} onClick={add}>
                Make token
              </Button>
            </li>
          )}
        </ul>
      )}

      {created && <CreatedDialog token={created} onClose={() => setCreated(null)} />}
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          description="Whatever sends work in with it will be refused from now on. Work it already sent in is kept."
          confirmLabel="Revoke token"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            setRevoking(null);
            tokens.revoke.mutate(revoking.id, { onError: fail('Could not revoke the token') });
          }}
        />
      )}
    </Section>
  );
}

/** The new token, shown the one time it can be, with how to send work in with it. */
function CreatedDialog({ token, onClose }: { token: CreatedIntakeToken; onClose: () => void }) {
  const toast = useToast();
  const url = webhookUrl();
  const curl = [
    `curl -X POST ${url} \\`,
    `  -H 'Authorization: Bearer ${token.token}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"title": "Printer on 3rd floor is jammed", "requester": "Jane Doe", "priority": "high"}'`,
  ].join('\n');
  const form = [
    `<form method="post" action="${url}">`,
    `  <input type="hidden" name="token" value="${token.token}">`,
    `  <input name="title" required>`,
    `  <textarea name="description"></textarea>`,
    `  <button>Send</button>`,
    `</form>`,
  ].join('\n');

  return (
    <Modal
      title={`${token.name} is ready`}
      description="Copy the token now. It is not shown again; if it is lost, revoke it and make another."
      onClose={onClose}
      wide
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-[var(--color-surface)] px-2 py-1.5 font-mono">{token.token}</code>
          <Button variant="subtle" className="text-xs" onClick={() => void copy(token.token, 'Token', toast)}>
            <Icon name="clipboard" /> Copy
          </Button>
        </div>
        <div>
          <p className="mb-1 font-medium">From a server or script</p>
          <pre className="scroll-thin overflow-x-auto rounded bg-[var(--color-surface)] p-2 font-mono">{curl}</pre>
        </div>
        <div>
          <p className="mb-1 font-medium">From a web form</p>
          <pre className="scroll-thin overflow-x-auto rounded bg-[var(--color-surface)] p-2 font-mono">{form}</pre>
          <p className="mt-1 text-[var(--color-muted)]">
            A token put in a public page can be read by anyone who views it, so it can only ever file work in this queue.
          </p>
        </div>
        <div>
          <p className="mb-1 font-medium">Fields</p>
          <ul className="space-y-0.5">
            {Object.entries(INTAKE_FIELDS).map(([field, about]) => (
              <li key={field}>
                <code className="font-mono">{field}</code> <span className="text-[var(--color-muted)]">— {about}</span>
              </li>
            ))}
            <li className="text-[var(--color-muted)]">Any other field is kept, listed under the description.</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}
