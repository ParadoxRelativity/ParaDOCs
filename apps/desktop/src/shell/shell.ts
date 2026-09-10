/**
 * The connection manager: the one screen that is native to the desktop app
 * rather than served by a ParaDOCs server. It lists the servers and local
 * workspaces the user has configured and opens one in its own window.
 *
 * Built with plain DOM on purpose — pulling React in here would double the
 * runtime shipped for what is a list and two forms.
 */

// Inlined as markup: the shell's CSP allows no fonts, so the icon font is out.
import globeIcon from 'bootstrap-icons/icons/globe2.svg';
import laptopIcon from 'bootstrap-icons/icons/laptop.svg';

interface Connection {
  id: string;
  label: string;
  kind: 'remote' | 'local';
  url?: string;
}

interface ServerCheck {
  ok: boolean;
  origin?: string;
  version?: string;
  error?: string;
}

type UpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  message?: string;
  reason?: string;
  autoDownload: boolean;
  checkOnLaunch: boolean;
}

interface Bridge {
  list(): Promise<Connection[]>;
  add(input: { label: string; kind: 'remote' | 'local'; url?: string }): Promise<Connection>;
  update(input: { id: string; label?: string; url?: string }): Promise<Connection>;
  remove(id: string): Promise<void>;
  open(id: string): Promise<void>;
  test(url: string): Promise<ServerCheck>;
  info(): Promise<{ version: string; platform: string; electron: string }>;
  onChanged(handler: () => void): () => void;
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    install(): Promise<void>;
    setAutoDownload(enabled: boolean): Promise<UpdateStatus>;
    setCheckOnLaunch(enabled: boolean): Promise<UpdateStatus>;
    onChanged(handler: (status: UpdateStatus) => void): () => void;
  };
}

const bridge = (window as unknown as { paradocs: Bridge }).paradocs;
const root = document.getElementById('app')!;

type View = { mode: 'list' } | { mode: 'add-remote' } | { mode: 'add-local' } | { mode: 'edit'; id: string };

let view: View = { mode: 'list' };
let connections: Connection[] = [];
let updates: UpdateStatus | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, ...rest } = props;
  if (className) node.className = className;
  Object.assign(node, rest);
  for (const child of children) node.append(child);
  return node;
}

async function refresh(): Promise<void> {
  [connections, updates] = await Promise.all([bridge.list(), bridge.updates.status()]);
  render();
}

function show(next: View): void {
  view = next;
  render();
}

function render(): void {
  root.replaceChildren();
  root.append(
    el('h1', {}, 'ParaDOCs'),
    el(
      'p',
      { class: 'subtitle' },
      view.mode === 'list'
        ? 'Open a workspace on this computer, or connect to a ParaDOCs server.'
        : 'Add a place to keep documents.',
    ),
  );

  if (view.mode === 'list') renderList();
  else if (view.mode === 'add-remote') renderRemoteForm();
  else if (view.mode === 'add-local') renderLocalForm();
  else renderEditForm(view.id);
}

function renderList(): void {
  if (connections.length === 0) {
    root.append(
      el(
        'div',
        { class: 'empty' },
        'Nothing configured yet. Create a local workspace to start writing straight away, or connect to a server you host.',
      ),
    );
  } else {
    const list = el('ul', { class: 'connections' });
    for (const connection of connections) list.append(renderRow(connection));
    root.append(el('p', { class: 'section-label' }, 'Workspaces'), list);
  }

  root.append(
    el(
      'div',
      { class: 'footer' },
      button('Connect to a server', () => show({ mode: 'add-remote' }), 'primary'),
      button('New local workspace', () => show({ mode: 'add-local' })),
    ),
  );
  renderUpdates();
}

// --- updates ----------------------------------------------------------------

function renderUpdates(): void {
  if (!updates) return;
  const status = updates;
  const row = el('div', { class: 'updates' });

  const text = el('div', { class: 'update-text' });
  const actions = el('div', { class: 'actions' });

  switch (status.phase) {
    case 'unsupported':
      text.append(
        el('div', { class: 'update-line' }, `Version ${status.currentVersion}`),
        el('div', { class: 'update-detail' }, status.reason ?? 'Updates are unavailable for this build.'),
      );
      break;
    case 'checking':
      text.append(el('div', { class: 'update-line' }, 'Checking for updates…'));
      break;
    case 'available':
      text.append(el('div', { class: 'update-line' }, `ParaDOCs ${status.newVersion} is available.`));
      actions.append(button('Download', () => void bridge.updates.check(), 'primary'));
      break;
    case 'downloading':
      text.append(
        el('div', { class: 'update-line' }, `Downloading ${status.newVersion ?? ''}…`.trim()),
        el('div', { class: 'update-detail' }, `${status.percent ?? 0}%`),
      );
      break;
    case 'downloaded':
      text.append(
        el('div', { class: 'update-line' }, `ParaDOCs ${status.newVersion} is ready.`),
        el('div', { class: 'update-detail' }, 'It installs when you quit, or restart now.'),
      );
      actions.append(button('Restart now', () => void bridge.updates.install(), 'primary'));
      break;
    case 'error':
      text.append(
        el('div', { class: 'update-line' }, `Version ${status.currentVersion}`),
        el('div', { class: 'update-detail error' }, status.message ?? 'Could not check for updates.'),
      );
      actions.append(button('Try again', () => void bridge.updates.check()));
      break;
    default:
      text.append(el('div', { class: 'update-line' }, `Version ${status.currentVersion}`));
      actions.append(button('Check for updates', () => void bridge.updates.check()));
  }

  row.append(text, actions);
  root.append(el('p', { class: 'section-label' }, 'Updates'), row);

  if (status.phase !== 'unsupported') {
    root.append(
      toggle('Check for updates automatically', status.checkOnLaunch, (on) =>
        bridge.updates.setCheckOnLaunch(on),
      ),
      toggle('Download updates in the background', status.autoDownload, (on) =>
        bridge.updates.setAutoDownload(on),
      ),
    );
  }
}

function toggle(label: string, checked: boolean, onChange: (value: boolean) => Promise<unknown>) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => {
    void onChange(input.checked).then(() => refresh());
  });
  return el('label', { class: 'toggle' }, input, label);
}

function renderRow(connection: Connection): HTMLLIElement {
  const detail = connection.kind === 'local' ? 'On this computer' : (connection.url ?? '');
  return el(
    'li',
    { class: 'connection' },
    el('span', {
      class: 'glyph',
      ariaHidden: 'true',
      innerHTML: connection.kind === 'local' ? laptopIcon : globeIcon,
    }),
    el(
      'div',
      { class: 'text' },
      el('div', { class: 'label' }, connection.label),
      el('div', { class: 'detail', title: detail }, detail),
    ),
    el(
      'div',
      { class: 'actions' },
      button('Open', () => void openConnection(connection), 'primary'),
      button('Edit', () => show({ mode: 'edit', id: connection.id }), 'quiet'),
    ),
  );
}

function button(label: string, onClick: () => void, variant = ''): HTMLButtonElement {
  const node = el('button', { class: variant, type: 'button' }, label);
  node.addEventListener('click', onClick);
  return node;
}

function field(labelText: string, input: HTMLInputElement): HTMLLabelElement {
  return el('label', { class: 'field' }, labelText, input);
}

function textInput(props: Partial<HTMLInputElement>): HTMLInputElement {
  return el('input', { type: 'text', autocomplete: 'off', spellcheck: false, ...props });
}

async function openConnection(connection: Connection): Promise<void> {
  try {
    await bridge.open(connection.id);
  } catch (err) {
    alertInline(`Could not open “${connection.label}”. ${message(err)}`);
  }
}

function alertInline(text: string): void {
  const existing = root.querySelector('.error.floating');
  existing?.remove();
  root.append(el('p', { class: 'error floating' }, text));
}

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Electron prefixes errors thrown across IPC with the handler's frame.
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

// --- forms ------------------------------------------------------------------

function renderRemoteForm(): void {
  const address = textInput({ placeholder: 'docs.example.com', spellcheck: false });
  const label = textInput({ placeholder: 'Optional' });
  const status = el('p', { class: 'hint' }, 'The address of a ParaDOCs server you host.');

  const form = el(
    'form',
    { class: 'card' },
    field('Server address', address),
    field('Name', label),
    status,
  );

  const test = button('Test connection', async () => {
    status.className = 'hint';
    status.textContent = 'Checking…';
    const result = await bridge.test(address.value);
    if (result.ok) {
      status.className = 'ok';
      status.textContent = `Reached ParaDOCs ${result.version ?? ''} at ${result.origin}.`.trim();
      if (!label.value.trim() && result.origin) label.value = new URL(result.origin).hostname;
    } else {
      status.className = 'error';
      status.textContent = result.error ?? 'Could not reach that server.';
    }
  });

  const save = el('button', { class: 'primary', type: 'submit' }, 'Add server');

  form.append(el('div', { class: 'form-actions' }, button('Cancel', () => show({ mode: 'list' }), 'quiet'), test, save));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.className = 'hint';
    status.textContent = 'Adding…';
    try {
      const created = await bridge.add({
        kind: 'remote',
        url: address.value,
        label: label.value || address.value,
      });
      show({ mode: 'list' });
      await openConnection(created);
    } catch (err) {
      status.className = 'error';
      status.textContent = message(err);
      save.disabled = false;
    }
  });

  root.append(form);
  address.focus();
}

function renderLocalForm(): void {
  const label = textInput({ placeholder: 'My documents', value: 'My documents' });
  const status = el(
    'p',
    { class: 'hint' },
    'A local workspace keeps its documents on this computer and needs no server. It is for one person: sharing and live collaboration need a server.',
  );
  const save = el('button', { class: 'primary', type: 'submit' }, 'Create workspace');
  const form = el('form', { class: 'card' }, field('Name', label), status);
  form.append(el('div', { class: 'form-actions' }, button('Cancel', () => show({ mode: 'list' }), 'quiet'), save));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    status.className = 'hint';
    status.textContent = 'Preparing the database…';
    try {
      const created = await bridge.add({ kind: 'local', label: label.value });
      show({ mode: 'list' });
      await openConnection(created);
    } catch (err) {
      status.className = 'error';
      status.textContent = message(err);
      save.disabled = false;
    }
  });

  root.append(form);
  label.select();
}

function renderEditForm(id: string): void {
  const connection = connections.find((c) => c.id === id);
  if (!connection) {
    show({ mode: 'list' });
    return;
  }

  const label = textInput({ value: connection.label });
  const address = textInput({ value: connection.url ?? '' });
  const status = el('p', { class: 'hint' }, connection.kind === 'local' ? 'Stored on this computer.' : '');
  const form = el('form', { class: 'card' }, field('Name', label));
  if (connection.kind === 'remote') form.append(field('Server address', address));
  form.append(status);

  const remove = button(
    connection.kind === 'local' ? 'Remove from list' : 'Remove server',
    async () => {
      await bridge.remove(connection.id);
      show({ mode: 'list' });
    },
    'quiet danger',
  );
  // Removing a local workspace only forgets it; the documents stay on disk.
  if (connection.kind === 'local') {
    status.textContent = 'Removing a local workspace takes it off this list. Its documents stay on this computer.';
  }

  const save = el('button', { class: 'primary', type: 'submit' }, 'Save');
  form.append(
    el(
      'div',
      { class: 'form-actions' },
      remove,
      button('Cancel', () => show({ mode: 'list' }), 'quiet'),
      save,
    ),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await bridge.update({
        id: connection.id,
        label: label.value,
        ...(connection.kind === 'remote' ? { url: address.value } : {}),
      });
      show({ mode: 'list' });
    } catch (err) {
      status.className = 'error';
      status.textContent = message(err);
    }
  });

  root.append(form);
  label.focus();
}

bridge.onChanged(() => void refresh());
bridge.updates.onChanged((status) => {
  updates = status;
  if (view.mode === 'list') render();
});
void refresh();
