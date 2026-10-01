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

const workingGpu = {
  requestAdapter: async () => ({ info: { vendor: 'test' }, limits: {}, features: new Set() }),
};

function setupRoomPage(search = '?room=abcdef', navigatorOverride = { gpu: workingGpu, userAgent: 'test' }, pageOverride = {}) {
  const ids = [
    'room-message', 'room-panel', 'room-name', 'room-connection', 'room-roster', 'room-count',
    'room-game-status', 'cancel-room-launch', 'lobby-card', 'room-setup', 'room-invite',
    'invite-link', 'join-room', 'create-room', 'copy-invite', 'leave-room', 'status', 'start',
    'reload', 'overlay', 'controls', 'show-controls', 'hide-controls', 'canvas', 'volume',
    'volume-value', 'toggle-mute', 'keyboard-off', 'binding-help', 'room-code',
    'hint', 'diag', 'diag-text', 'diag-copy', 'game-runtime', 'save-status',
  ];
  const elements = new Map(ids.map((id) => [id, new Element(id)]));
  elements.get('start').disabled = true;
  elements.get('diag').hidden = true;
  elements.get('save-status').hidden = true;
  elements.get('game-runtime').content = { querySelectorAll: () => [{
    attributes: [{ name: 'src', value: 'WiiCompiled.js' }, { name: 'async', value: '' }], textContent: '',
  }] };
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
  const location = new URL(`https://game.test/${search}`);
  const context = vm.createContext({
    URL,
    URLSearchParams,
    AbortSignal,
    WebSocket: FakeWebSocket,
    document,
    location: { href: location.href, hostname: location.hostname, search: location.search },
    window,
    navigator: navigatorOverride,
    self: { crossOriginIsolated: true, isSecureContext: true },
    WebAssembly: { Suspending() {}, promising() {} },
    localStorage,
    ENV: {},
    console,
    setTimeout: () => { const timer = {}; timers.add(timer); return timer; },
    clearTimeout: (timer) => timers.delete(timer),
    setInterval: () => 0,
    Image: class { set src(value) { this.source = value; } },
    addEventListener() {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    ...pageOverride,
  });
  vm.runInContext(inlineScript, context, { filename: 'shell.html inline script' });
  return { context, elements, localValues, sockets: FakeWebSocket.instances, timers, window, body };
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

test('manual Play is single-shot and reveals the game immediately', () => {
  const { context, elements, sockets } = setupRoomPage('?room=abcdef&manual');
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

test('direct Play keeps the lobby overlay until the runtime reports ready', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const start = elements.get('start');
  const socket = sockets[0];
  const controls = elements.get('controls');
  const roomPanel = elements.get('room-panel');
  const lobbyCard = elements.get('lobby-card');
  const overlay = elements.get('overlay');
  const cancel = elements.get('cancel-room-launch');
  const calls = [];
  module.callMain = (args) => calls.push(args);

  socket.open();
  welcome(socket);
  module.onRuntimeInitialized();
  module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_DIRECT_JOIN, '1');
  assert.equal(context.ENV.MKW_WEB_AUTO_JOIN, undefined, 'the old macro flag is removed');
  assert.equal(context.ENV.MKW_WEB_ROOM.includes('/v1/rooms/abcdef/ws'), true);

  start.dispatch('click');
  start.dispatch('click');

  assert.equal(calls.length, 1, 'direct Play must start the game once');
  assert.equal(overlay.hidden, false, 'the overlay remains while the direct room connection initializes');
  assert.equal(roomPanel.parentNode, lobbyCard, 'the lobby stays visible in the overlay');
  assert.equal(start.hidden, true);
  assert.equal(start.disabled, true);
  assert.equal(cancel.hidden, false);
  assert.equal(elements.get('status').textContent, 'Starting a direct connection to your room…');

  context.window.mkwSetRoomLaunchStatus('Connecting directly to your room…', 'loading');
  assert.equal(overlay.hidden, false);
  assert.equal(cancel.hidden, false);
  assert.equal(elements.get('status').textContent, 'Connecting directly to your room…');

  context.window.mkwSetRoomLaunchStatus('Character and vehicle selection is ready.', 'ready');
  assert.equal(overlay.hidden, true);
  assert.equal(roomPanel.parentNode, controls);
  assert.equal(cancel.hidden, true);
  assert.equal(elements.get('canvas').focused, true);
  assert.equal(elements.get('room-game-status').textContent, 'Character and vehicle selection is ready.');
  context.window.mkwSetRoomLaunchStatus('Late loading update.', 'loading');
  assert.equal(overlay.hidden, true, 'late loading updates must not reopen a settled launch');
});

test('direct launch accepts a runtime manual handoff and Cancel invokes the export once', () => {
  for (const cancelFromUi of [false, true]) {
    const { context, elements, sockets } = setupRoomPage();
    const module = context.Module;
    const start = elements.get('start');
    const socket = sockets[0];
    const controls = elements.get('controls');
    const roomPanel = elements.get('room-panel');
    const overlay = elements.get('overlay');
    const cancel = elements.get('cancel-room-launch');
    const calls = [];
    let cancelCalls = 0;
    module.callMain = (args) => calls.push(args);
    module._mkw_web_cancel_room_launch = () => { cancelCalls++; };

    socket.open();
    welcome(socket);
    module.onRuntimeInitialized();
    start.dispatch('click');
    assert.equal(calls.length, 1);
    assert.equal(overlay.hidden, false);

    if (cancelFromUi) {
      cancel.dispatch('click');
      cancel.dispatch('click');
      assert.equal(cancelCalls, 1, 'the cancel export is called once');
      assert.match(elements.get('room-game-status').textContent, /manually/);
    } else {
      context.window.mkwSetRoomLaunchStatus('Continue through the menus.', 'manual');
      assert.equal(cancelCalls, 0);
    }

    assert.equal(overlay.hidden, true);
    assert.equal(roomPanel.parentNode, controls);
    assert.equal(cancel.hidden, true);
    assert.equal(elements.get('canvas').focused, true);
    context.window.mkwSetRoomLaunchStatus('Late loading update.', 'loading');
    assert.equal(overlay.hidden, true, 'manual handoff must stay settled');
  }
});

test('a failed direct launch keeps its error and Reload visible against late status updates', () => {
  const { context, elements, sockets } = setupRoomPage();
  const module = context.Module;
  const socket = sockets[0];
  const calls = [];
  module.callMain = (args) => calls.push(args);
  socket.open();
  welcome(socket);
  module.onRuntimeInitialized();
  elements.get('start').dispatch('click');

  context.window.mkwSetRoomLaunchStatus('The room connection failed.', 'failed');
  assert.equal(elements.get('overlay').hidden, false);
  assert.equal(elements.get('room-panel').parentNode, elements.get('lobby-card'));
  assert.equal(elements.get('status').textContent, 'The room connection failed.');
  assert.equal(elements.get('reload').hidden, false);
  assert.equal(elements.get('start').hidden, true);
  assert.equal(elements.get('cancel-room-launch').hidden, true);

  context.window.mkwSetRoomLaunchStatus('Late success.', 'ready');
  module.setStatus('late download status');
  assert.equal(elements.get('overlay').hidden, false);
  assert.equal(elements.get('status').textContent, 'The room connection failed.');
  assert.equal(elements.get('reload').hidden, false);
  assert.equal(calls.length, 1);
});

test('manual invite and no-room Start keep the normal immediate reveal', () => {
  for (const search of ['?room=abcdef&manual', '?']) {
    const { context, elements, sockets } = setupRoomPage(search);
    const module = context.Module;
    const start = elements.get('start');
    const controls = elements.get('controls');
    const roomPanel = elements.get('room-panel');
    const calls = [];
    module.callMain = (args) => calls.push(args);

    if (sockets[0]) {
      sockets[0].open();
      welcome(sockets[0]);
    }
    module.onRuntimeInitialized();
    module.preRun[0]();
    assert.equal(context.ENV.MKW_WEB_DIRECT_JOIN, undefined);
    assert.equal(context.ENV.MKW_WEB_AUTO_JOIN, undefined);
    start.dispatch('click');

    assert.equal(calls.length, 1);
    assert.equal(elements.get('overlay').hidden, true);
    assert.equal(roomPanel.parentNode, controls);
    assert.equal(elements.get('cancel-room-launch').hidden, true);
  }
});

test('copied room invites omit the manual opt-out flag', () => {
  const { elements } = setupRoomPage('?room=abcdef&manual');
  const invite = new URL(elements.get('invite-link').value);
  assert.equal(invite.searchParams.get('room'), 'abcdef');
  assert.equal(invite.searchParams.has('manual'), false);
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
  context.window.mkwSetRoomLaunchStatus('Late direct ready.', 'ready');
  assert.equal(status.textContent, fatalMessage, 'a late room callback must not clear a fatal abort');
  assert.equal(reload.hidden, false);
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('WebGPU without a graphics adapter is explained before Start and cannot be started', async () => {
  const gpu = { requestAdapter: async () => null };
  const { context, elements } = setupRoomPage('', { gpu, userAgent: 'Mozilla/5.0 Chrome/150.0 Safari/537.36' });
  await settle();
  const module = vm.runInContext('Module', context);
  module.onRuntimeInitialized();

  const start = elements.get('start');
  assert.equal(start.hidden, true, 'a finished runtime load must not bring the Start button back');
  assert.match(elements.get('status').textContent, /missing: a usable WebGPU graphics adapter/);
  assert.match(elements.get('hint').textContent, /Hardware acceleration/);
  assert.equal(elements.get('hint').hidden, false);
  assert.equal(elements.get('diag').hidden, false);
  assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): no adapter/);
  assert.match(elements.get('diag-text').textContent, /User agent: .*Chrome\/150/);
});

test('a browser without the WebGPU API gets advice for its own family', async () => {
  const firefox = setupRoomPage('', { userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/156.0' });
  await settle();
  assert.match(firefox.elements.get('status').textContent, /missing: WebGPU\./);
  assert.match(firefox.elements.get('hint').textContent, /Firefox only turns WebGPU on/);

  const iphone = setupRoomPage('', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) CriOS/150 Mobile Safari/604.1' });
  await settle();
  assert.match(iphone.elements.get('hint').textContent, /Safari 27/);
});

test('a working adapter leaves the page alone', async () => {
  const { context, elements } = setupRoomPage();
  await settle();
  assert.doesNotMatch(elements.get('status').textContent, /missing/);
  assert.equal(elements.get('diag-text').textContent, '', 'no diagnostics are shown when nothing failed');
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('a browser-default adapter can start when high-performance selection returns nothing', async () => {
  const attempts = [];
  const { context, elements, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async (options) => {
      attempts.push(options.powerPreference || 'default');
      return options.powerPreference ? null : workingGpu.requestAdapter();
    } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.deepEqual(attempts, ['high-performance', 'default']);
  assert.equal(vm.runInContext('runtimeFailed', context), false);
  assert.doesNotMatch(elements.get('status').textContent, /missing/);
  assert.equal(body.children.length, 1, 'the loader must start after a successful fallback');
  assert.equal(body.children[0].attributes.get('src'), 'WiiCompiled.js');
});

test('low-power selection can recover after a thrown preferred request and a null default', async () => {
  const attempts = [];
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async (options) => {
      attempts.push(options.powerPreference || 'default');
      if (options.powerPreference === 'high-performance') throw new Error('preferred adapter unavailable');
      return options.powerPreference === 'low-power' ? workingGpu.requestAdapter() : null;
    } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.deepEqual(attempts, ['high-performance', 'default', 'low-power']);
  assert.equal(body.children.length, 1);
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('the normal high-performance path does not request additional adapters', async () => {
  let calls = 0;
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: async () => { calls++; return workingGpu.requestAdapter(); } },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.equal(calls, 1);
  assert.equal(body.children.length, 1);
});

test('missing JSPI or adapters never load the heavyweight game runtime', async () => {
  for (const [navigatorOverride, pageOverride] of [
    [{ gpu: workingGpu, userAgent: 'test' }, { WebAssembly: {} }],
    [{ gpu: { requestAdapter: async () => null }, userAgent: 'test' }, {}],
    [{ userAgent: 'test' }, {}],
  ]) {
    const { context, body } = setupRoomPage('', navigatorOverride, pageOverride);
    await vm.runInContext('loadRuntime()', context);
    assert.equal(body.children.length, 0);
  }
});

test('the runtime loader waits for the asynchronous GPU probe', async () => {
  let resolveAdapter;
  const { context, body } = setupRoomPage('', {
    userAgent: 'test', gpu: { requestAdapter: () => new Promise((resolve) => { resolveAdapter = resolve; }) },
  });
  const loading = vm.runInContext('loadRuntime()', context);
  await settle();
  assert.equal(body.children.length, 0);
  resolveAdapter(await workingGpu.requestAdapter());
  await loading;
  assert.equal(body.children.length, 1);
});

test('a failed loader download displays an actionable abort instead of staying on Loading', async () => {
  const { context, elements, body } = setupRoomPage('');
  await vm.runInContext('loadRuntime()', context);
  body.children[0].dispatch('error');
  assert.match(elements.get('status').textContent, /The game loader could not be downloaded/);
  assert.equal(elements.get('start').hidden, true);
});

test('denied persistent saving still loads the game and selects session-only storage', async () => {
  const { context, elements, body } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: {
      getDirectory: async () => { throw new Error('Storage access denied'); },
    },
  });
  await vm.runInContext('loadRuntime()', context);
  assert.equal(body.children.length, 1);
  assert.equal(elements.get('save-status').hidden, false);
  assert.match(elements.get('save-status').textContent, /reload or close this page/);
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, '1');
  assert.equal(vm.runInContext('runtimeFailed', context), false);
});

test('available persistent saving does not switch to session-only storage', async () => {
  const { context, elements } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: { getDirectory: async () => ({}) },
  });
  await vm.runInContext('loadRuntime()', context);
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, undefined);
  assert.equal(elements.get('save-status').hidden, true);
});

test('an absent saving API warns about temporary progress without blocking the loader', async () => {
  const { context, elements, body } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' });
  await vm.runInContext('loadRuntime()', context);
  context.Module.preRun[0]();
  assert.equal(body.children.length, 1);
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, '1');
  assert.equal(elements.get('save-status').hidden, false);
});

test('the loader waits for the saving probe before publishing its storage choice', async () => {
  let resolveStorage;
  const { context, body } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', storage: {
      getDirectory: () => new Promise((resolve) => { resolveStorage = resolve; }),
    },
  });
  const loading = vm.runInContext('loadRuntime()', context);
  await settle();
  assert.equal(body.children.length, 0);
  resolveStorage({});
  await loading;
  context.Module.preRun[0]();
  assert.equal(context.ENV.MKW_WEB_SESSION_STORAGE, undefined);
  assert.equal(body.children.length, 1);
});

test('binding guidance describes the actual session-only or persistent saving mode', async () => {
  for (const persistent of [false, true]) {
    const { context, elements } = setupRoomPage('', {
      gpu: workingGpu, userAgent: 'test',
      storage: persistent ? { getDirectory: async () => ({}) } : undefined,
    });
    await vm.runInContext('loadRuntime()', context);
    context.window.mkwSetBindings(JSON.stringify({ keyboard: true, editing: false, muted: false }));
    assert.match(elements.get('binding-help').textContent,
      persistent ? /saved in this browser/ : /reload or close this page/);
  }
});

test('missing JSPI and adapter show both remedies without claiming acceleration is off', async () => {
  const { context, elements } = setupRoomPage('', {
    gpu: { requestAdapter: async () => null },
    userAgent: 'Mozilla/5.0 Chrome/150.0 Safari/537.36',
  }, { WebAssembly: {} });
  await settle();
  const hint = elements.get('hint').textContent;
  assert.match(elements.get('status').textContent, /WebAssembly JSPI, a usable WebGPU graphics adapter/);
  assert.match(hint, /WebAssembly JSPI is unavailable/);
  assert.match(hint, /fully quit and reopen/);
  assert.match(hint, /WebGPU found no usable graphics adapter/);
  assert.match(hint, /Hardware acceleration being enabled does not guarantee/);
  assert.match(hint, /chrome:\/\/gpu/);
  assert.doesNotMatch(elements.get('status').textContent, /hardware acceleration/);
  context.Module.onRuntimeInitialized();
  assert.equal(elements.get('start').hidden, true);
});

test('JSPI needs both callable APIs, including when an older flag exposes only one', async () => {
  for (const wasm of [{ Suspending() {} }, { promising() {} }, { Suspending: undefined, promising() {} }]) {
    const { elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, { WebAssembly: wasm });
    await settle();
    assert.match(elements.get('status').textContent, /missing: WebAssembly JSPI\./);
    assert.match(elements.get('diag-text').textContent, /WebAssembly JSPI: false/);
    assert.match(elements.get('hint').textContent, /A flag cannot add support/);
  }
});

test('successful asynchronous GPU details are included in an already visible JSPI report', async () => {
  const { elements } = setupRoomPage('', { gpu: workingGpu, userAgent: 'test' }, { WebAssembly: {} });
  await settle();
  assert.match(elements.get('diag-text').textContent, /Adapter: test/);
  assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): adapter available/);
  assert.match(elements.get('diag-text').textContent, /WebAssembly.promising: undefined/);
});

test('a present but unusable gpu property reports a missing API without crashing the page', async () => {
  for (const gpu of [undefined, null, {}]) {
    const { elements } = setupRoomPage('', { gpu, userAgent: 'test' });
    await settle();
    assert.match(elements.get('status').textContent, /missing: WebGPU\./);
    assert.equal(elements.get('start').hidden, true);
  }
});

test('adapter request errors retain their reason and use the browser-specific diagnostics page', async () => {
  for (const [userAgent, diagnosticPage] of [
    ['Mozilla/5.0 Chrome/150 Safari/537.36 Edg/150', 'edge://gpu'],
    ['Mozilla/5.0 Firefox/156.0', 'about:support (Graphics)'],
  ]) {
    const { elements } = setupRoomPage('', {
      gpu: { requestAdapter: async () => { throw new Error('driver rejected request'); } }, userAgent,
    });
    await settle();
    assert.ok(elements.get('hint').textContent.includes(diagnosticPage));
    assert.match(elements.get('diag-text').textContent, /requestAdapter \(high-performance\) threw: Error: driver rejected request/);
    assert.doesNotMatch(elements.get('diag-text').textContent, /requestAdapter \(high-performance\): no adapter/);
  }
});

test('a rejected clipboard promise gives a manual copy instruction', async () => {
  const { elements } = setupRoomPage('', {
    userAgent: 'test', clipboard: { writeText: async () => { throw new Error('permission denied'); } },
  });
  elements.get('diag-copy').dispatch('click');
  await settle();
  assert.match(elements.get('diag-copy').textContent, /Select the technical details/);
});

test('copy includes the completed GPU probe and confirms success', async () => {
  let copied;
  const { elements } = setupRoomPage('', {
    gpu: workingGpu, userAgent: 'test', clipboard: { writeText: async (text) => { copied = text; } },
  }, { WebAssembly: {} });
  await settle();
  elements.get('diag-copy').dispatch('click');
  await settle();
  assert.match(copied, /Adapter: test/);
  assert.equal(elements.get('diag-copy').textContent, 'Copied');
});

test('insecure and unisolated pages show their connection remedies alongside JSPI advice', async () => {
  const { elements } = setupRoomPage('', { userAgent: 'test' }, {
    WebAssembly: {}, self: { crossOriginIsolated: false, isSecureContext: false },
  });
  await settle();
  const hint = elements.get('hint').textContent;
  assert.match(hint, /WebAssembly JSPI is unavailable/);
  assert.match(hint, /HTTPS link/);
  assert.match(hint, /isolation headers/);
  assert.match(elements.get('diag-text').textContent, /Secure context: false/);
});

test('running out of memory while loading explains itself and keeps the details', () => {
  const { context, elements } = setupRoomPage('');
  const module = vm.runInContext('Module', context);
  module.onAbort('InternalError: out of memory');
  assert.match(elements.get('status').textContent, /The game stopped: InternalError: out of memory/);
  assert.match(elements.get('hint').textContent, /ran out of memory while loading/);
  assert.equal(elements.get('hint').hidden, false);
  assert.match(elements.get('diag-text').textContent, /Stopped with: InternalError: out of memory/);
});
