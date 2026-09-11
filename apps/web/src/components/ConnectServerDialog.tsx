import { useState } from 'react';
import { requireDesktop } from '../lib/desktop';
import { cx } from '../lib/util';
import { Modal } from './Modal';
import { FIELD } from './SettingsParts';
import { Button } from './ui';

/** Adds a ParaDOCs server to the desktop app, which then switches the window to it. */
export default function ConnectServerDialog({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'test' | 'connect' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function test() {
    setBusy('test');
    setMessage(null);
    const result = await requireDesktop().connections.test(address);
    setBusy(null);
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error ?? 'Could not reach that server.' });
      return;
    }
    setMessage({
      tone: 'ok',
      text: result.version
        ? `Reached ParaDOCs ${result.version} at ${result.origin}.`
        : `Reached ParaDOCs at ${result.origin}.`,
    });
    if (!label.trim() && result.origin) setLabel(new URL(result.origin).hostname);
  }

  async function connect(event?: React.FormEvent) {
    event?.preventDefault();
    if (!address.trim() || busy) return;
    setBusy('connect');
    setMessage(null);
    const result = await requireDesktop().connections.connect({ url: address, label });
    if (result.ok) {
      // The window has already moved to the server; this page is behind it now.
      onClose();
      return;
    }
    setBusy(null);
    setMessage({ tone: 'error', text: result.error });
  }

  const blocked = !address.trim() || busy !== null;

  return (
    <Modal
      title="Connect to a server"
      description="Add a ParaDOCs server you use. It opens in this window, and its workspaces join the workspace menu."
      onClose={onClose}
      footer={
        <>
          <Button variant="subtle" className="text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="subtle" className="text-xs" disabled={blocked} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="primary" className="text-xs" disabled={blocked} onClick={() => void connect()}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void connect(event)} className="space-y-2">
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Server address</span>
          <input
            autoFocus
            className={FIELD}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="docs.example.com"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-[var(--color-muted)]">Name (optional)</span>
          <input
            className={FIELD}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Shown in the workspace menu"
          />
        </label>
        {message && (
          <p className={cx('text-xs', message.tone === 'ok' ? 'text-emerald-600' : 'text-red-500')}>{message.text}</p>
        )}
        {/* Lets Enter submit a form with more than one field. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
