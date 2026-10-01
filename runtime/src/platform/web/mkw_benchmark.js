// Opt-in, per-step multiplayer measurements. No timers or sampling thread in the game worker.
// Both the baseline and candidate must contain this same collector.
addToLibrary({
  $MkwBenchmark: {
    config: null, channel: null, steps: [], frames: [], warmup: 0,
    lastStep: null, start: null, idle: 0, disc: 0, online: 0, capturing: false, done: false,
    lastNetwork: {tx: 0, rx: 0}, lastPresent: null,
    raceTick: 0, lastRaceTime: null, stopInput: false, initTime: 0, stage: -1, result: null, published: false,
    conditions: null, menuInput: null, qualifiedRace: false,
    send: function(message) {
      if (MkwBenchmark.channel) MkwBenchmark.channel.postMessage(message);
    },
    init: function(config, settings) {
      const b = MkwBenchmark;
      b.config = config;
      globalThis.__mkwBenchmarkActive = true;
      b.settings = settings;
      b.initTime = performance.timeOrigin + performance.now();
      b.channel = new BroadcastChannel('mkw-benchmark-' + config.run_id + '-' + config.player_id);
      b.channel.onmessage = (event) => {
        if (event.data && event.data.type === 'cancel') b.finish(event.data.reason || 'cancelled');
        if (event.data && event.data.type === 'stop-input') b.stopInput = true;
        if (event.data && event.data.type === 'menu-input' && b.config.input_recipe === 'ghost-v1' && !b.qualifiedRace) {
          const v = event.data;
          if (Number.isInteger(v.buttons) && v.buttons >= 0 && v.buttons <= 65535 &&
              Number.isInteger(v.steer) && Math.abs(v.steer) <= 127) {
            b.menuInput = {buttons: v.buttons, steer: v.steer, until: performance.timeOrigin + performance.now() + 250};
          }
        }
        if (event.data && event.data.type === 'publish' && b.result && !b.published) {
          b.published = true;
          b.send({type: 'result', report: b.result});
        }
      };
      b.send({type: 'ready', settings: settings});
    },
    network: function() {
      const n = globalThis.__mkwVnet;
      return n ? {tx: n.benchUdpSent || 0, rx: n.benchUdpReceived || 0,
                  buffered: n.ws ? n.ws.bufferedAmount : 0, inbox: n.inboxBytes, status: n.status}
               : {tx: 0, rx: 0, buffered: 0, inbox: 0, status: 3};
    },
    finish: function(reason) {
      const b = MkwBenchmark;
      if (b.done || !b.config) return;
      b.done = true;
      globalThis.__mkwBenchmarkActive = false;
      b.capturing = false;
      // emscripten_get_now already includes timeOrigin for pthread builds.
      b.result = {
        schema_version: 3, clock: 'emscripten-pthreads-epoch-ms', run_id: b.config.run_id, player_id: b.config.player_id,
        warmup_steps: b.config.warmup_steps, measure_steps: b.config.measure_steps,
        input_recipe: b.config.input_recipe,
        workload_mode: b.config.workload_mode || 'multiplayer', race_conditions: b.conditions,
        settings: b.settings, started_at_ms: b.start, ended_at_ms: b.lastStep,
        aborted: reason || null, steps: b.steps, frames: b.frames,
        // steps: interval, VI idle sleep, disc time, online checks, UDP sent/received,
        //        WebSocket buffered bytes, receive-queue bytes, connection status, race stage.
        // frames: owning step, epoch timestamp after presentation, presented-frame interval,
        //         guest, drain, copy, frame-worker wait, overlay, present (all times in ms).
      };
      // Cloning/saving a large result on one client must not spike the peer's still-running
      // measurement. The page asks the local server for the all-clients-finished barrier.
      b.send({type: 'finished', ended_at_ms: b.lastStep});
    },
    step: function(now, idle, disc, stage, course, engine, mode, players, firstPlayerType) {
      const b = MkwBenchmark;
      if (!b.config) return;
      b.lastRaceTime = now;
      const previousStage = b.stage;
      b.stage = stage;
      if (stage !== 2) {
        if (b.capturing) b.finish('race left active racing phase before the window finished');
        b.lastStep = null;
        b.warmup = b.raceTick = b.online = 0;
        b.lastPresent = null;
        if (stage >= 3 && b.qualifiedRace) b.stopInput = true;
        if (!b.done && previousStage !== stage) b.send({type: 'progress', phase: 'waiting for GO', steps: 0});
        return;
      }
      ++b.raceTick;
      if (b.done) return;
      const conditions = {course_id: course, engine_class: engine, game_mode: mode, player_count: players,
                          is_ghost_replay: (mode === 2 || mode === 5) && players > 0 && firstPlayerType === 3};
      const ghostMode = b.config.workload_mode === 'ghost';
      const qualifies = ghostMode ? conditions.is_ghost_replay && course === b.config.expected_course_id
        : players === (b.config.expected_players || 2) && !conditions.is_ghost_replay && b.network().status === 1;
      if (!qualifies) {
        if (b.capturing) b.finish('race no longer matches the requested workload');
        b.lastStep = b.lastPresent = null;
        b.warmup = b.online = b.raceTick = 0;
        return;
      }
      b.qualifiedRace = true;
      if (b.conditions && JSON.stringify(b.conditions) !== JSON.stringify(conditions)) {
        b.finish('race course/class/player conditions changed during measurement');
        return;
      }
      b.conditions = conditions;
      const net = b.network();
      if (b.capturing) {
        b.steps.push([now - b.lastStep, idle, disc, b.online,
                      net.tx - b.lastNetwork.tx, net.rx - b.lastNetwork.rx,
                      net.buffered, net.inbox, net.status, stage]);
      } else if (b.lastStep !== null) {
        ++b.warmup;
      }
      b.lastStep = now;
      b.lastNetwork = net;
      b.online = 0;
      if (!b.capturing && b.warmup >= b.config.warmup_steps) {
        b.capturing = true;
        b.start = now;
        b.send({type: 'started', at_ms: now});
      }
      if (b.steps.length === b.config.measure_steps) b.finish(null);
      else if ((!b.capturing && b.warmup % 60 === 0) || (b.capturing && b.steps.length % 60 === 0)) {
        b.send({type: 'progress', phase: b.capturing ? 'recording' : 'warming',
                steps: b.capturing ? b.steps.length : b.warmup});
      }
    },
    present: function(now, guest, drain, copy, wait, overlay, present) {
      const b = MkwBenchmark;
      if (!b.config || b.done) return;
      if (b.capturing) {
        // The interval before the first measured present crosses the warmup boundary. Exclude it.
        const interval = b.lastPresent === null ? null : now - b.lastPresent;
        b.frames.push([b.steps.length, now, interval,
                       guest, drain, copy, wait, overlay, present]);
      }
      b.lastPresent = b.capturing ? now : null;
    },
    input: function(now) {
      const b = MkwBenchmark;
      if (!b.config || b.stopInput) return 0;
      if (b.config.input_recipe === 'ghost-v1') {
        const m = b.menuInput;
        return !b.qualifiedRace && m && now <= m.until ? (0x80000000 | ((m.steer & 255) << 16) | m.buttons) >>> 0 : 0;
      }
      if (b.config.input_recipe !== 'autodrive-v1') return 0;
      let buttons = 0, steer = 0;
      if (b.lastRaceTime === null) {
        // Held A for six frames, then a release. This selects defaults during local-room setup;
        // it does not bypass the game's menus, matchmaking or race protocol.
        buttons = (now - b.initTime) % 1500 < 100 ? 0x0100 : 0;
      } else {
        if (now - b.lastRaceTime > 500) return 0; // race ended / paused: hand control back
        // Versioned motion workload, identical in every simulation step on both peers. It is a
        // stress recipe, not a lap-time AI: crashes and missed item boxes are expected.
        const phase = b.raceTick % 720;
        buttons = 0x0100; // accelerate
        if (phase >= 420 && phase < 540) steer = 55;
        if (phase >= 600) steer = -55;
        if (b.raceTick % 180 < 2) buttons |= 0x0010; // use any held item
      }
      return (0x80000000 | ((steer & 255) << 16) | buttons) >>> 0;
    },
  },
  mkw_benchmark_init__deps: ['$MkwBenchmark', '$UTF8ToString'],
  mkw_benchmark_init: function(config, settings) {
    MkwBenchmark.init(JSON.parse(UTF8ToString(config)), JSON.parse(UTF8ToString(settings)));
  },
  mkw_benchmark_step__deps: ['$MkwBenchmark'],
  mkw_benchmark_step: function(now, idle, disc, stage, course, engine, mode, players, firstPlayerType) {
    MkwBenchmark.step(now, idle, disc, stage, course, engine, mode, players, firstPlayerType);
  },
  mkw_benchmark_present__deps: ['$MkwBenchmark'],
  mkw_benchmark_present: function(now, guest, drain, copy, wait, overlay, present) {
    MkwBenchmark.present(now, guest, drain, copy, wait, overlay, present);
  },
  mkw_benchmark_online__deps: ['$MkwBenchmark'],
  mkw_benchmark_online: function() { if (!MkwBenchmark.done) ++MkwBenchmark.online; },
  mkw_benchmark_input__deps: ['$MkwBenchmark'],
  mkw_benchmark_input: function() { return MkwBenchmark.input(performance.timeOrigin + performance.now()); },
});
