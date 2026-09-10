/**
 * The screen-share picker. Every screen and window is shown as a live
 * thumbnail, so what the call will see is seen before it is shared.
 *
 * Plain DOM, like the connection manager. The page cannot look for sources
 * itself: the main process sends the list, refreshed while the picker is open,
 * and the page can only answer with one of the ids it was sent.
 */

export {};

interface Source {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  thumbnail: string | null;
  icon: string | null;
}

interface PickerBridge {
  onSources(handler: (sources: Source[]) => void): void;
  choose(id: string, audio: boolean): void;
  cancel(): void;
}

const bridge = (window as unknown as { picker: PickerBridge }).picker;
const params = new URLSearchParams(location.search);
const platform = params.get('platform') ?? '';

document.documentElement.dataset.platform = platform;
// The system accent, where there is one, so the selection matches the OS.
const accent = params.get('accent') ?? '';
if (/^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--accent', accent);

const grid = document.getElementById('grid') as HTMLElement;
const shareButton = document.getElementById('share') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel') as HTMLButtonElement;
const audioOption = document.getElementById('audio-option') as HTMLLabelElement;
const audioBox = document.getElementById('audio') as HTMLInputElement;
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

audioOption.hidden = params.get('audio') !== '1';

let tab: Source['kind'] = 'screen';
let sources: Source[] = [];
let selected: string | null = null;
let received = false;
/** Cards are kept between refreshes, so a thumbnail updates in place and focus is not lost. */
const cards = new Map<string, HTMLButtonElement>();

function visible(): Source[] {
  return sources.filter((source) => source.kind === tab);
}

/** Points an image at a picture, adding or removing the element as needed. */
function setImage(parent: Element, src: string | null, before: Element | null = null) {
  let image = parent.querySelector<HTMLImageElement>(':scope > img');
  if (!src) {
    image?.remove();
    return;
  }
  if (!image) {
    image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    parent.insertBefore(image, before);
  }
  if (image.src !== src) image.src = src;
}

function cardFor(source: Source): HTMLButtonElement {
  let card = cards.get(source.id);
  if (!card) {
    card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.setAttribute('role', 'option');
    card.dataset.id = source.id;
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const label = document.createElement('span');
    label.className = 'label';
    const name = document.createElement('span');
    name.className = 'name';
    label.append(name);
    card.append(thumb, label);
    card.addEventListener('click', () => select(source.id));
    card.addEventListener('dblclick', () => share(source.id));
    card.addEventListener('focus', () => select(source.id));
    cards.set(source.id, card);
  }

  const thumb = card.querySelector('.thumb')!;
  thumb.classList.toggle('empty', !source.thumbnail);
  setImage(thumb, source.thumbnail);
  const label = card.querySelector('.label')!;
  const name = label.querySelector('.name')!;
  setImage(label, source.icon, name);
  name.textContent = source.name;
  card.title = source.name;
  return card;
}

function notice(): string {
  if (!received) return 'Looking for screens and windows…';
  if (sources.length === 0 && platform === 'darwin') {
    return 'ParaDOCs is not allowed to record the screen. Allow it under System Settings → Privacy & Security → Screen Recording, then quit and reopen ParaDOCs.';
  }
  if (sources.length === 0) return 'No screens or windows are available to share.';
  return tab === 'window' ? 'No windows are open.' : 'No screens are available.';
}

function render() {
  for (const button of tabs) {
    const kind = button.dataset.tab as Source['kind'];
    button.setAttribute('aria-selected', String(kind === tab));
    button.querySelector('.count')!.textContent = received
      ? String(sources.filter((source) => source.kind === kind).length)
      : '';
  }

  // A window that closed takes its card with it.
  for (const [id, card] of cards) {
    if (!sources.some((source) => source.id === id)) {
      card.remove();
      cards.delete(id);
    }
  }

  const list = visible();
  if (selected && !list.some((source) => source.id === selected)) selected = null;

  if (list.length === 0) {
    const message = document.createElement('p');
    message.className = 'notice';
    message.textContent = notice();
    grid.replaceChildren(message);
  } else {
    const nodes = list.map(cardFor);
    const current = Array.from(grid.children);
    // Only re-parented when the order changed: moving a focused card blurs it.
    if (current.length !== nodes.length || nodes.some((node, index) => current[index] !== node)) {
      grid.replaceChildren(...nodes);
    }
  }

  for (const card of cards.values()) {
    const on = card.dataset.id === selected;
    card.classList.toggle('selected', on);
    card.setAttribute('aria-selected', String(on));
  }
  shareButton.disabled = selected === null;
}

function select(id: string) {
  if (selected === id) return;
  selected = id;
  render();
}

function share(id: string | null = selected) {
  if (id) bridge.choose(id, !audioOption.hidden && audioBox.checked);
}

/** Moves the selection and focus together, without relying on a focus event to follow. */
function focusCard(index: number) {
  const list = visible();
  const source = list[Math.max(0, Math.min(list.length - 1, index))];
  if (!source) return;
  select(source.id);
  cards.get(source.id)?.focus();
}

for (const button of tabs) {
  button.addEventListener('click', () => {
    tab = button.dataset.tab as Source['kind'];
    render();
  });
}
shareButton.addEventListener('click', () => share());
cancelButton.addEventListener('click', () => bridge.cancel());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    bridge.cancel();
    return;
  }

  const onCard = event.target instanceof HTMLElement && event.target.classList.contains('card');
  // Enter on Cancel or a tab does what that button does; anywhere else it shares.
  if (event.key === 'Enter' && selected && (onCard || !(event.target instanceof HTMLButtonElement))) {
    event.preventDefault();
    share();
    return;
  }

  if (!onCard) return;
  // Steps from the card that has focus, which is where the eye is.
  const focusedId = (event.target as HTMLElement).dataset.id;
  const index = visible().findIndex((source) => source.id === focusedId);
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
  if (step !== undefined) {
    event.preventDefault();
    focusCard(index + step);
  }
});

bridge.onSources((next) => {
  const first = !received;
  received = true;
  sources = next;
  if (first) {
    // One screen is the common case, so it starts selected; sharing it still
    // takes a press of Share.
    const screens = next.filter((source) => source.kind === 'screen');
    if (screens.length === 1) selected = screens[0].id;
    else if (screens.length === 0 && next.length > 0) tab = 'window';
  }
  render();
  if (first) (grid.querySelector<HTMLElement>('.card.selected') ?? grid.querySelector<HTMLElement>('.card'))?.focus();
});

render();
