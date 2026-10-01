import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const shell = await readFile(new URL('../shell.html', import.meta.url), 'utf8');
const inlineScript = shell.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'shell must contain its inline frontend script');

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.parentNode = null;
    this.classList = { add() {}, toggle() {} };
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    for (const callback of this.listeners.get(type) || []) {
      callback({ ...event, currentTarget: this, target: event.target || this });
    }
  }

  moveChildren(nodes, prepend) {
    for (const node of nodes) {
      if (node.parentNode) {
        node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
      }
      node.parentNode = this;
    }
    this.children = prepend ? [...nodes, ...this.children] : [...this.children, ...nodes];
  }

  append(...nodes) { this.moveChildren(nodes, false); }
  prepend(...nodes) { this.moveChildren(nodes, true); }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  querySelector(selector) {
    return selector === 'h2' ? this.heading : null;
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() { this.focused = true; }
  select() {}
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(text) { this.sent.push(text); }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function setupRoomPage() {
  const ids = [
    'room-message', 'room-panel', 'room-name', 'room-connection', 'room-roster', 'room-count',
    'room-game-status', 'cancel-auto-join', 'lobby-card', 'room-setup', 'room-invite',
    'invite-link', 'join-room', 'create-room', 'copy-invite', 'leave-room', 'status', 'start',
    'reload', 'overlay', 'controls', 'show-controls', 'hide-controls', 'canvas', 'volume',
    'volume-value', 'toggle-mute', 'keyboard-off', 'binding-help', 'room-code',
  ];
  const elements = new Map(ids.map((id) => [id, new Element(id)]));
  elements.get('start').disabled = true;
  const roomPanel = elements.get('room-panel');
  roomPanel.heading = new Element('room-heading');
  roomPanel.children = [roomPanel.heading];
  roomPanel.heading.parentNode = roomPanel;
  const controlsPanel = elements.get('controls');
  controlsPanel.append(roomPanel);
  elements.get('room-name').value = 'Racer';
  const body = new Element('body');
  const document = {
    body,
    activeElement: null,
    getElementById: (id) => elements.get(id),
    createElement: (tag) => new Element(tag),
    querySelectorAll: () => [],
  };
  const localValues = new Map();
  localValues.set('mkw-room-name', 'Racer');
  const localStorage = {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, value),
  };
  const timers = new Set();
  FakeWebSocket.instances = [];
  const window = { addEventListener() {} };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    AbortSignal,
    WebSocket: FakeWebSocket,
    document,
    location: { href: 'https://game.test/?room=abcdef', hostname: 'game.test', search: '?room=abcdef' },
    window,
    navigator: { gpu: {} },
    self: { crossOriginIsolated: true },
    WebAssembly: { Suspending() {} },
    localStorage,
    console,
    setTimeout: () => { const timer = {}; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    setInterval: () => 0,
    Image: class { set src(value) { this.source = value; } },
    addEventListener() {},
    fetch: async () => { throw new Error('unexpected fetch'); },
  });
  vm.runInContext(inlineScript, context, { filename: 'shell.html inline script' });
  return { context, elements, localValues, sockets: FakeWebSocket.instances, timers, window };
}

function welcome(socket) {
  socket.message({ type: 'welcome', token: 'a'.repeat(32), id: 7 });
}

test('an early lobby open and name edit use the socket without calling the Wasm export', () => {
  const { context, elements, localValues, sockets, window } = setupRoomPage();
  const module = context.Module;
  let nativeCalls = 0;
  module._mkw_web_room_name = () => {
    assert.equal(vm.runInContext('runtimeReady', context), true, 'Wasm export called before runtime readiness');
    nativeCalls++;
  };

  const socket = sockets[0];
  assert.ok(socket, 'room invite should connect immediately');
  assert.doesNotThrow(() => socket.open());
  assert.deepEqual(socket.sent.map(JSON.parse), [{ type: 'name', name: 'Racer' }]);

  const name = elements.get('room-name');
  name.value = '  Guest Name  ';
  assert.doesNotThrow(() => name.dispatch('input'));
  assert.equal(window.mkwRoomName, 'Guest Name');
  assert.equal(localValues.get('mkw-room-name'), 'Guest Name');
  assert.deepEqual(socket.sent.map(JSON.parse), [
    { type: 'name', name: 'Racer' },
    { type: 'name', name: 'Guest Name' },
  ]);
  assert.equal(nativeCalls, 0);

  module.onRuntimeInitialized();
  name.dispatch('change');
  assert.equal(nativeCalls, 1, 'room name should notify Wasm after initialization');
});

test('Play stays disabled until both lobby welcome and runtime readiness, in either order', () => {
  for (const readyFirst of ['runtime', 'lobby']) {
    const { context, elements, sockets } = setupRoomPage();
    const start = elements.get('start');
    const socket = sockets[0];
    socket.open();
    assert.equal(start.disabled, true, readyFirst);
    if (readyFirst === 'runtime') {
      context.Module.onRuntimeInitialized();
      assert.equal(start.disabled, true, 'runtime alone must not enable Play');
      welcome(socket);
    } else {
      welcome(socket);
      assert.equal(start.disabled, true, 'lobby welcome alone must not enable Play');
      context.Module.onRuntimeInitialized();
    }
    assert.equal(start.disabled, false, readyFirst);
    assert.equal(start.textContent, 'Play online');
  }
});

test('starting the game is single-shot and returns the room panel to controls', () => {
  const { context, elements, sockets } = setupRoomPage();
  const start = elements.get('start');
  const socket = sockets[0];
  const controls = elements.get('controls');
  const roomPanel = elements.get('room-panel');
  const lobbyCard = elements.get('lobby-card');
  const calls = [];
  context.Module.callMain = (args) => calls.push(args);

  socket.open();
  welcome(socket);
  context.Module.onRuntimeInitialized();
  assert.equal(start.disabled, false);
  assert.equal(roomPanel.parentNode, lobbyCard);

  start.dispatch('click');
  start.dispatch('click');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 0);
  assert.equal(roomPanel.parentNode, controls);
  assert.equal(controls.children[0], roomPanel);
  assert.equal(lobbyCard.children.includes(roomPanel), false);
  assert.equal(elements.get('overlay').hidden, true);
  for (const id of ['create-room', 'join-room', 'room-code']) {
    assert.equal(elements.get(id).disabled, true, `${id} should be disabled after starting`);
  }
});

test('an abort remains fatal when late download and readiness callbacks arrive', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const status = elements.get('status');
  const start = elements.get('start');
  const overlay = elements.get('overlay');
  const reload = elements.get('reload');
  const calls = [];
  module.callMain = (args) => calls.push(args);

  module.onAbort('test failure');
  const fatalMessage = 'The game stopped: test failure (details in the browser console).';
  assert.equal(status.textContent, fatalMessage);
  assert.equal(overlay.hidden, false);
  assert.equal(start.hidden, true);
  assert.equal(reload.hidden, false);

  module.setStatus('Downloading data (1/5)');
  module.onRuntimeInitialized();
  const socket = sockets[0];
  socket.open();
  welcome(socket);

  assert.equal(status.textContent, fatalMessage);
  assert.equal(reload.hidden, false);
  assert.equal(start.hidden, true);
  assert.equal(start.disabled, true);
  assert.equal(vm.runInContext('runtimeFailed', context), true);
  assert.equal(vm.runInContext('runtimeReady', context), false);

  start.dispatch('click');
  assert.equal(calls.length, 0, 'fatal runtime state must never enter the game');
});
