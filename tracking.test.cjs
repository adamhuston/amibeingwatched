const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const GROUPS = ['resource', 'planet', 'DMC', 'military', 'cubesat'];
const record = {
  OBJECT_NAME: 'Test imaging satellite', NORAD_CAT_ID: 12345,
  EPOCH: '2026-11-07T00:00:00', MEAN_MOTION: 15, ECCENTRICITY: 0,
  INCLINATION: 98, RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0,
};

function environment(extras = {}) {
  let now = NOW;
  let id = 0;
  const timers = new Map();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: Clock, URL, AbortController,
    console: { warn() {}, error() {} },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms, interval: false }); return id; },
    setInterval(fn, ms) { timers.set(++id, { fn, ms, interval: true }); return id; },
    clearTimeout(key) { timers.delete(key); },
    clearInterval(key) { timers.delete(key); },
    ...extras,
  });
  return {
    context, timers,
    advance(ms) { now += ms; },
    fire(ms) {
      for (const [key, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        if (!timer.interval) timers.delete(key);
        timer.fn();
      }
    },
  };
}

async function loadModule(filename, env, mocks = {}) {
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const module = Object.hasOwn(mocks, name)
      ? new vm.SyntheticModule(Object.keys(mocks[name]), function () {
        for (const [key, value] of Object.entries(mocks[name])) this.setExport(key, value);
      }, { context: env.context })
      : new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, name), 'utf8'), {
        context: env.context, identifier: name,
        initializeImportMeta(meta) { meta.url = pathToFileURL(path.join(__dirname, name)).href; },
      });
    modules.set(name, module);
    await module.link(specifier => load(specifier));
    return module;
  }
  const module = await load(filename);
  await module.evaluate();
  return module.namespace;
}

const CDN = 'https://cdn.jsdelivr.net/npm/satellite.js@7.0.0/+esm';
const flush = () => new Promise(resolve => setImmediate(resolve));

function catalogEnvironment(fetchImpl, storage = new Map()) {
  return environment({
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    fetch: fetchImpl,
  });
}

test('fresh timestamps with missing, empty, malformed or invalid cache data fetch again', async () => {
  for (const cached of [undefined, '[]', '{', '[{}]']) {
    const storage = new Map();
    for (const group of GROUPS) {
      storage.set(`tle_timestamp_GROUP_${group}`, String(NOW));
      if (cached !== undefined) storage.set(`tle_data_GROUP_${group}`, cached);
    }
    let requests = 0;
    const env = catalogEnvironment(async () => {
      requests++;
      return { ok: true, json: async () => [record] };
    }, storage);
    const sats = await loadModule('satellites.js', env, { [CDN]: {} });
    assert.equal((await sats.loadImagingSatellites()).length, 1);
    assert.equal(requests, 5);
    assert.equal(env.timers.size, 0);
  }
});

test('partial catalogs fail explicitly and recovery only fetches the missing group', async () => {
  let unavailable = true;
  const requests = [];
  const env = catalogEnvironment(async url => {
    const group = new URL(url).searchParams.get('GROUP');
    requests.push(group);
    if (group === 'resource' && unavailable) return { ok: false, status: 503 };
    return { ok: true, json: async () => [record] };
  });
  const sats = await loadModule('satellites.js', env, { [CDN]: {} });
  await assert.rejects(sats.loadImagingSatellites(), /Incomplete satellite catalog.*resource/);
  unavailable = false;
  assert.equal((await sats.loadImagingSatellites()).length, 1);
  assert.deepEqual(requests.slice(5), ['resource']);
});

test('expired valid caches survive offline failures and HTTP rate limits', async () => {
  for (const offline of [true, false]) {
    const storage = new Map();
    for (const group of GROUPS) {
      storage.set(`tle_timestamp_GROUP_${group}`, String(NOW - 3 * 60 * 60_000));
      storage.set(`tle_data_GROUP_${group}`, JSON.stringify([record]));
    }
    const env = catalogEnvironment(async () => {
      if (offline) throw new Error('Offline');
      return { ok: false, status: 403 };
    }, storage);
    const sats = await loadModule('satellites.js', env, { [CDN]: {} });
    assert.equal((await sats.loadImagingSatellites()).length, 1);
  }
});

test('storage failures do not discard successful network data', async () => {
  const env = catalogEnvironment(async () => ({ ok: true, json: async () => [record] }));
  env.context.localStorage = {
    getItem() { throw new Error('Storage disabled'); },
    setItem() { throw new Error('Quota exceeded'); },
  };
  const sats = await loadModule('satellites.js', env, { [CDN]: {} });
  assert.equal((await sats.loadImagingSatellites()).length, 1);
});

test('hung catalog requests abort after 15 seconds instead of stalling startup', async () => {
  const env = catalogEnvironment((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }));
  const sats = await loadModule('satellites.js', env, { [CDN]: {} });
  const loading = sats.loadImagingSatellites();
  const rejected = assert.rejects(loading, /Incomplete satellite catalog/);
  env.fire(15_000);
  await rejected;
  assert.equal(env.timers.size, 0);
});

function orbitMock() {
  return {
    json2satrec: omm => omm,
    gstime: () => 0,
    propagate: (omm, date) => omm.invalid ? null : {
      position: { x: 7000, y: 0, z: 0, elevation: omm.elevation((date.getTime() - NOW) / 60_000) },
    },
    eciToEcf: position => position,
    ecfToLookAngles: (observer, position) => ({
      azimuth: 1, elevation: position.elevation * Math.PI / 180,
    }),
  };
}

function triangularPass(t, peakTime, peakElevation) {
  return Math.max(-10, peakElevation - Math.abs(t - peakTime) * 30);
}

test('prediction searches later passes after a low first pass, including currently visible satellites', async () => {
  for (const firstPeak of [0, 10]) {
    const env = environment();
    const passes = await loadModule('passes.js', env, { [CDN]: orbitMock() });
    const result = passes.findNextOverheadPass([{
      ...record,
      elevation: t => Math.max(triangularPass(t, firstPeak, 40), triangularPass(t, 100, 85)),
    }], {});
    assert.ok(result);
    assert.equal(result.minutesAway, 100);
    assert.equal(result.peakElevationDeg, 85);
  }
});

test('prediction keeps earliest qualifying peak across satellites and respects 24h window', async () => {
  const env = environment();
  const passes = await loadModule('passes.js', env, { [CDN]: orbitMock() });
  const result = passes.findNextOverheadPass([
    { ...record, elevation: t => triangularPass(t, 100, 85) },
    { ...record, OBJECT_NAME: 'Earlier', elevation: t => triangularPass(t, 20, 85) },
  ], {});
  assert.equal(result.name, 'Earlier');
  assert.equal(result.minutesAway, 20);
  assert.equal(passes.findNextOverheadPass([
    { ...record, elevation: t => triangularPass(t, 1441, 85) },
  ], {}), null);
  assert.equal(passes.findNextOverheadPass([{ ...record, elevation: () => -10 }], {}), null);
});

test('total propagation failure is not reported as zero satellites or no pass', async () => {
  const env = environment();
  const sats = await loadModule('satellites.js', env, { [CDN]: orbitMock() });
  const passes = await loadModule('passes.js', env, { [CDN]: orbitMock() });
  assert.throws(() => sats.getOverheadSatellites([{ invalid: true }], {}), /No satellite positions/);
  assert.throws(() => passes.findNextOverheadPass([{ invalid: true }], {}), /No satellite positions/);
  assert.throws(() => sats.getOverheadSatellites([{ elevation: () => NaN }], {}), /No satellite positions/);
  assert.throws(() => passes.findNextOverheadPass([{ elevation: () => NaN }], {}), /No satellite positions/);
  assert.equal(sats.getOverheadSatellites([{ ...record, elevation: () => -10 }], {}).length, 0);
});

function appEnvironment() {
  const elements = new Map();
  const listeners = new Map();
  const windowListeners = new Map();
  const workers = [];
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', style: {}, classList: classList(),
      replaceChildren() {}, append() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  let failLoad = false;
  let failPositions = false;
  let loadCount = 0;
  let overhead = [{ name: 'Visible', inFOV: true, nearby: true, elevationDeg: 85 }];
  const env = environment({
    document: {
      body: { classList: classList() }, visibilityState: 'visible',
      getElementById: getElement,
      addEventListener: (name, fn) => listeners.set(name, fn),
      createDocumentFragment: () => ({ appendChild() {} }),
      createElement: () => ({ append() {} }),
    },
    window: { addEventListener: (name, fn) => windowListeners.set(name, fn) },
    navigator: { geolocation: { getCurrentPosition: resolve => resolve({
      coords: { latitude: 40, longitude: -75 },
    }) } },
    Worker: class {
      constructor(url, options) {
        assert.equal(options.type, 'module');
        assert.ok(url.href.endsWith('passes-worker.js'));
        workers.push(this);
      }
      postMessage(data) { this.data = data; }
      terminate() { this.terminated = true; }
    },
  });
  return {
    ...env, elements, listeners, windowListeners, workers,
    failLoad(value) { failLoad = value; },
    failPositions(value) { failPositions = value; },
    setOverhead(value) { overhead = value; },
    get loadCount() { return loadCount; },
    mocks: {
      [CDN]: { degreesToRadians: deg => deg * Math.PI / 180 },
      './satellites.js': {
        CACHE_TTL_MS: 2 * 60 * 60_000,
        loadImagingSatellites: async () => {
          loadCount++;
          if (failLoad) throw new Error('Incomplete satellite catalog');
          return [record];
        },
        getOverheadSatellites: () => {
          if (failPositions) throw new Error('No satellite positions');
          return overhead;
        },
        getSolarElevationDeg: () => 30,
        observationLikelihood: () => 84,
      },
    },
  };
}

test('loading and worker failure never show a false no-pass result; positions refresh while predicting', async () => {
  const env = appEnvironment();
  await loadModule('app.js', env, env.mocks);
  await flush();
  assert.equal(env.elements.get('in-fov').textContent, 1);
  assert.match(env.elements.get('next-pass').textContent, /Calculating/);
  env.setOverhead([]);
  env.fire(5_000);
  assert.equal(env.elements.get('in-fov').textContent, 0);
  assert.match(env.elements.get('next-pass').textContent, /Calculating/);
  env.workers[0].onmessage({ data: { error: 'Prediction failed' } });
  env.fire(5_000);
  assert.equal(env.elements.get('next-pass').textContent, 'Pass prediction unavailable');
  env.fire(5 * 60_000);
  env.workers[1].onmessage({ data: { result: null, computedAt: NOW } });
  assert.equal(env.elements.get('next-pass').textContent, 'No overhead pass in 24h');
});

test('catalog failures clear readings and retry without manual reload', async () => {
  const env = appEnvironment();
  env.failLoad(true);
  await loadModule('app.js', env, env.mocks);
  await flush();
  assert.equal(env.elements.get('in-fov').textContent, '—');
  assert.match(env.elements.get('error').textContent, /Retrying automatically/);
  assert.doesNotMatch(env.elements.get('next-pass').textContent, /No overhead/);
  env.failLoad(false);
  env.fire(30_000);
  await flush();
  assert.equal(env.elements.get('in-fov').textContent, 1);
  assert.equal(env.loadCount, 2);
});

test('resume, online and TTL reload tracking without duplicate timers or stale worker results', async () => {
  const env = appEnvironment();
  await loadModule('app.js', env, env.mocks);
  await flush();
  const oldWorker = env.workers[0];
  env.listeners.get('visibilitychange')();
  env.windowListeners.get('online')();
  await flush();
  assert.equal(env.loadCount, 2);
  assert.equal(oldWorker.terminated, true);
  oldWorker.onmessage({ data: { result: null, computedAt: NOW } });
  assert.match(env.elements.get('next-pass').textContent, /Calculating/);
  assert.equal([...env.timers.values()].filter(timer => timer.ms === 5_000).length, 1);
  env.fire(2 * 60 * 60_000);
  await flush();
  assert.equal(env.loadCount, 3);
  env.windowListeners.get('pageshow')({ persisted: true });
  await flush();
  assert.equal(env.loadCount, 4);
});

test('worker timeout and position failures are explicit and recover automatically', async () => {
  const env = appEnvironment();
  await loadModule('app.js', env, env.mocks);
  await flush();
  env.fire(120_000);
  assert.equal(env.workers[0].terminated, true);
  assert.equal(env.elements.get('next-pass').textContent, 'Pass prediction unavailable');
  env.failPositions(true);
  env.fire(5_000);
  assert.equal(env.elements.get('in-fov').textContent, '—');
  env.failPositions(false);
  env.fire(30_000);
  await flush();
  assert.equal(env.elements.get('in-fov').textContent, 1);
});

test('pass countdown includes time spent in the worker', async () => {
  const env = appEnvironment();
  await loadModule('app.js', env, env.mocks);
  await flush();
  env.advance(60_000);
  env.workers[0].onmessage({ data: {
    result: { name: 'Next', minutesAway: 10 }, computedAt: NOW,
  } });
  assert.equal(env.elements.get('next-pass').textContent, 'Next overhead in 9m');
});

test('worker reports success and calculation errors with a computation-start timestamp', async () => {
  for (const failure of [false, true]) {
    const messages = [];
    const env = environment({ self: { postMessage: message => messages.push(message) } });
    await loadModule('passes-worker.js', env, {
      './passes.js': { findNextOverheadPass() {
        if (failure) throw new Error('No positions');
        env.advance(60_000);
        return null;
      } },
    });
    env.context.self.onmessage({ data: { sats: [], observerGd: {} } });
    if (failure) assert.equal(messages[0].error, 'No positions');
    else {
      assert.equal(messages[0].result, null);
      assert.equal(messages[0].computedAt, NOW);
    }
  }
});

test('service worker precaches the prediction worker in the new app-shell version', () => {
  let shell;
  const env = environment({
    self: {
      addEventListener(event, fn) {
        if (event === 'install') fn({ waitUntil() {} });
      },
      skipWaiting() {},
    },
    caches: { open: async name => {
      assert.equal(name, 'satellite-overhead-v21');
      return { addAll: async files => { shell = files; } };
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'), env.context);
  return flush().then(() => {
    assert.ok(shell.includes('./passes-worker.js'));
    for (const file of shell) assert.ok(fs.existsSync(path.join(__dirname, file)));
  });
});
