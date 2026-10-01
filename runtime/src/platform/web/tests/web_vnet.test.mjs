import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web_vnet.cpp', import.meta.url), 'utf8');
function setup() {
  const heap = new Uint8Array(140000);
  const context = vm.createContext({
    ArrayBuffer, Uint8Array, HEAPU8: heap, UTF8ToString: value => value,
    console: {log() {}, error() {}},
    WebSocket: class {
      constructor(url) { this.url = url; this.bufferedAmount = 0; this.sent = []; this.closed = []; }
      send(bytes) { this.sent.push(bytes); }
      close(code, reason) { this.closed.push({code, reason}); }
    },
  });
  for (const [name, args] of [
    ['vnet_js_open', 'url'], ['vnet_js_status', ''],
    ['vnet_js_send', 'data, size'], ['vnet_js_take', 'data, capacity'],
  ]) {
    const start = source.indexOf(', ' + name + ',');
    assert.ok(start >= 0, name + ' is defined');
    const bodyStart = source.indexOf('{', start) + 1;
    const bodyEnd = source.indexOf('\n});', bodyStart);
    assert.ok(bodyEnd > bodyStart);
    vm.runInContext('function ' + name + '(' + args + ') {' + source.slice(bodyStart, bodyEnd) + '}', context);
  }
  context.vnet_js_open('wss://room.test/room');
  const state = context.__mkwVnet;
  state.ws.onopen();
  const receive = bytes => state.ws.onmessage({data: bytes.buffer});
  return {context, state, heap, receive};
}

test('a mixed packet burst remains in exact arrival order through compaction', () => {
  const {context, state, heap, receive} = setup();
  for (let i = 0; i < 6000; i++) receive(Uint8Array.of([0x80, 0x81, 0x83, 0x84, 0x85][i % 5], i >> 8, i & 255));
  assert.equal(state.inboxBytes, 18000);
  for (let i = 0; i < 6000; i++) {
    assert.equal(context.vnet_js_take(0, heap.length), 3);
    assert.deepEqual([...heap.slice(0, 3)], [[0x80, 0x81, 0x83, 0x84, 0x85][i % 5], i >> 8, i & 255]);
  }
  assert.equal(context.vnet_js_take(0, heap.length), -1);
  assert.equal(state.inboxBytes, 0);
  assert.equal(state.inbox.length, 0);
});

test('consumed queue slots do not count against the pending-message limit', () => {
  const {context, state, heap, receive} = setup();
  for (let i = 0; i < 8192; i++) receive(Uint8Array.of(0x81));
  for (let i = 0; i < 500; i++) context.vnet_js_take(0, heap.length);
  for (let i = 0; i < 500; i++) receive(Uint8Array.of(0x83));
  assert.equal(state.status, 1);
  assert.equal(state.inboxBytes, 8192);
  receive(Uint8Array.of(0x84));
  assert.equal(state.status, 3);
  assert.equal(state.ws.closed[0].code, 1009);
});

test('oversized frames and excessive byte backlog retain the existing disconnect limits', () => {
  const oversized = setup();
  oversized.receive(new Uint8Array(70001));
  assert.equal(oversized.state.status, 3);
  assert.equal(oversized.state.inboxBytes, 0);

  const burst = setup();
  const packet = new Uint8Array(65536);
  for (let i = 0; i < 256; i++) burst.receive(packet);
  assert.equal(burst.state.status, 1);
  burst.receive(Uint8Array.of(0x81));
  assert.equal(burst.state.status, 3);
  assert.equal(burst.state.inboxBytes, 16 * 1024 * 1024);
});

test('WebSocket sends own their bytes when the Wasm heap changes afterwards', () => {
  const {context, state, heap} = setup();
  heap.set([1, 2, 3, 4], 100);
  context.vnet_js_send(100, 4);
  heap.fill(255, 100, 104);
  assert.deepEqual([...state.ws.sent[0]], [1, 2, 3, 4]);
  state.ws.bufferedAmount = 16 * 1024 * 1024;
  context.vnet_js_send(100, 4);
  assert.equal(state.status, 3);
  assert.equal(state.ws.closed[0].code, 1013);
  assert.equal(state.ws.sent.length, 1);
});

test('benchmark counters and queue byte accounting remain correct across mixed traffic', () => {
  const {context, state, heap, receive} = setup();
  context.__mkwBenchmarkActive = true;
  receive(Uint8Array.of(0x81, 1, 2));
  receive(Uint8Array.of(0x83, 3, 4, 5));
  assert.equal(state.benchUdpReceived, 1);
  heap.set([1, 10, 20], 100);
  context.vnet_js_send(100, 3);
  assert.equal(state.benchUdpSent, 1);
  context.vnet_js_take(0, heap.length);
  assert.equal(state.inboxBytes, 4);
  context.vnet_js_take(0, heap.length);
  assert.equal(state.inboxBytes, 0);
});
