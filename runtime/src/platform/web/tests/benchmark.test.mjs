import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../mkw_benchmark.js', import.meta.url), 'utf8');
function setup(warmup = 1, steps = 3, autoPublish = true) {
  let library;
  const messages = [];
  const context = vm.createContext({
    addToLibrary: value => { library = value; },
    performance: {timeOrigin: 100000, now: () => 0},
    BroadcastChannel: class { postMessage(value) {
      messages.push(structuredClone(value));
      if (autoPublish && value.type === 'finished') this.onmessage({data: {type: 'publish'}});
    } },
    __mkwVnet: {benchUdpSent: 0, benchUdpReceived: 0, inboxBytes: 0, status: 1, ws: {bufferedAmount: 0}},
  });
  vm.runInContext(source, context);
  context.MkwBenchmark = library.$MkwBenchmark;
  const b = context.MkwBenchmark;
  const step = b.step;
  b.step = (now, idle, disc, stage = 2, course = 0, engine = 2, mode = 6, players = 2, type = 0) =>
    step(now, idle, disc, stage, course, engine, mode, players, type);
  b.init({run_id: 'test', player_id: 'host', warmup_steps: warmup, measure_steps: steps}, {interpolation_fps: 0});
  return {b, context, messages};
}

test('fixed simulation-step window excludes warmup and retains every presentation gap', () => {
  const {b, context, messages} = setup();
  b.present(5, 1, 0, 0, 0, 0, 1);
  b.step(10, 100, 50);
  b.step(20, 5, 0);
  b.present(25, 2, .1, .1, 0, .2, 3);
  ++b.online;
  context.__mkwVnet.benchUdpSent++;
  context.__mkwVnet.benchUdpReceived++;
  b.step(30, 4, 0);
  // A skipped draw still advances the race. The next presented interval must include it.
  ++b.online;
  b.step(40, 0, 0);
  b.present(45, 2, .1, .1, 0, .2, 3);
  ++b.online;
  b.step(50, 3, 8);
  const result = messages.find(m => m.type === 'result').report;
  assert.equal(result.steps.length, 3);
  assert.equal(result.frames.length, 2);
  assert.equal(result.started_at_ms, 20);
  assert.equal(result.ended_at_ms, 50);
  assert.equal(result.frames[0][2], null);
  assert.equal(result.frames[1][2], 20);
  assert.equal(result.steps[0][4], 1);
  assert.equal(result.steps[0][5], 1);
  assert.equal(result.steps[2][2], 8);
  assert.equal(result.aborted, null);
  assert.equal(context.__mkwBenchmarkActive, false);
});

test('zero warmup starts on the first race calculation and finishes exactly once', () => {
  const {b, messages} = setup(0, 1);
  b.step(100, 0, 0);
  b.present(110, 0, 0, 0, 0, 0, 0);
  b.step(120, 0, 0);
  b.step(130, 0, 0);
  b.present(140, 0, 0, 0, 0, 0, 0);
  assert.equal(messages.filter(m => m.type === 'result').length, 1);
  assert.equal(messages.find(m => m.type === 'result').report.steps.length, 1);
});

test('cancel preserves partial samples and cannot manufacture a complete run', () => {
  const {b, messages} = setup(0, 3);
  b.step(100, 0, 0);
  b.step(120, 0, 0);
  b.channel.onmessage({data: {type: 'cancel', reason: 'page closed'}});
  const result = messages.find(m => m.type === 'result').report;
  assert.equal(result.steps.length, 1);
  assert.equal(result.aborted, 'page closed');
});

test('online evidence is separate from simulation count and network disconnects remain visible', () => {
  const {b, context, messages} = setup(0, 1);
  b.step(1, 0, 0);
  context.__mkwVnet.status = 3;
  context.__mkwVnet.inboxBytes = 512;
  b.step(17, 0, 0);
  const report = messages.find(m => m.type === 'result').report;
  assert.match(report.aborted, /no longer matches/);
  assert.equal(report.steps.length, 0);
});

test('scripted controller follows simulation steps, releases menu confirms and can be stopped', () => {
  const {b} = setup(0, 1);
  b.config.input_recipe = 'autodrive-v1';
  b.initTime = 0;
  assert.equal(b.input(50) & 0xffff, 0x0100);
  assert.equal(b.input(200) & 0xffff, 0);
  b.step(300, 0, 0);
  b.raceTick = 450;
  assert.equal((b.input(310) >> 16) & 255, 55);
  b.raceTick = 650;
  assert.equal((b.input(310) >> 16) & 255, (-55 & 255));
  assert.equal(b.input(900), 0);
  b.stopInput = true;
  assert.equal(b.input(310), 0);
});

test('pthread epoch clock is not offset twice and intro/countdown steps are excluded', () => {
  const {b, messages} = setup(0, 1);
  b.step(100010, 0, 0, 0);
  b.step(100020, 0, 0, 1);
  assert.equal(messages.filter(m => m.type === 'started').length, 0);
  b.step(100030, 0, 0, 2);
  b.present(100035, 0, 0, 0, 0, 0, 0);
  b.step(100046, 0, 0, 2);
  const report = messages.find(m => m.type === 'result').report;
  assert.equal(report.started_at_ms, 100030);
  assert.equal(report.ended_at_ms, 100046);
  assert.equal(report.frames[0][1], 100035);
  assert.equal(report.steps[0][9], 2);
});

test('leaving the race while recording preserves an explicitly incomplete result', () => {
  const {b, messages} = setup(0, 3);
  b.step(100, 0, 0, 2);
  b.step(116, 0, 0, 2);
  b.step(132, 0, 0, 3);
  const report = messages.find(m => m.type === 'result').report;
  assert.equal(report.steps.length, 1);
  assert.match(report.aborted, /left active racing/);
});

test('large result export waits for the cross-client completion barrier', () => {
  const {b, messages} = setup(0, 1, false);
  b.step(100000, 0, 0);
  b.present(100008, 0, 0, 0, 0, 0, 0);
  b.step(100016, 0, 0);
  assert.equal(messages.filter(m => m.type === 'result').length, 0);
  assert.equal(messages.filter(m => m.type === 'finished').length, 1);
  b.channel.onmessage({data: {type: 'publish'}});
  b.channel.onmessage({data: {type: 'publish'}});
  assert.equal(messages.filter(m => m.type === 'result').length, 1);
});

test('ghost setup pulses expire and never drive the car during a replay', () => {
  const {b} = setup(0, 1);
  b.config.input_recipe = 'ghost-v1';
  b.config.workload_mode = 'ghost';
  b.config.expected_course_id = 0;
  b.channel.onmessage({data: {type: 'menu-input', buttons: 256, steer: 0}});
  assert.equal(b.input(100100) & 0xffff, 256);
  assert.equal(b.input(100300), 0);
  b.step(100100, 0, 0, 2, 0, 2, 5, 1, 3);
  assert.equal(b.input(100101), 0);
  assert.equal(b.conditions.is_ghost_replay, true);
});

test('native course, class, mode and player count are captured and cannot change mid-window', () => {
  const {b, messages} = setup(0, 3);
  b.step(100000, 0, 0, 2, 0, 2, 6, 2, 0);
  b.step(100016, 0, 0, 2, 1, 2, 6, 2, 0);
  const report = messages.find(m => m.type === 'result').report;
  assert.equal(report.race_conditions.course_id, 0);
  assert.match(report.aborted, /conditions changed/);
});

test('title-screen demo cannot start a ghost baseline or disable its setup controls', () => {
  const {b, messages} = setup(0, 1);
  b.config.workload_mode = 'ghost';
  b.config.input_recipe = 'ghost-v1';
  b.config.expected_course_id = 0;
  b.step(100000, 0, 0, 2, 6, 2, 1, 12, 2);
  assert.equal(messages.filter(m => m.type === 'started').length, 0);
  b.channel.onmessage({data: {type: 'menu-input', buttons: 256, steer: 0}});
  assert.equal(b.input(100100) & 0xffff, 256);
  b.step(100120, 0, 0, 3, 6, 2, 1, 12, 2);
  assert.equal(b.stopInput, false);
  b.step(100160, 0, 0, 2, 0, 2, 5, 1, 3);
  assert.equal(messages.filter(m => m.type === 'started').length, 1);
});

test('benchmark hooks cover nocatchup and leave statistical profiling opt-in', async () => {
  const hooks = await readFile(new URL('../web_guest_hooks.cpp', import.meta.url), 'utf8');
  assert.ok(hooks.indexOf('RecordBenchmarkStep()') < hooks.indexOf('if (!s_catchup) return false;'));
  const platform = await readFile(new URL('../web_platform.cpp', import.meta.url), 'utf8');
  assert.ok(platform.includes('if (!WebPerformance::ProfilerEnabled()) return;'));
});
