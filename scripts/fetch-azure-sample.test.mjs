/**
 * Tests for the Azure trace loader.
 *
 * Run with `node --test scripts/`. No network: the streaming test serves a
 * gzipped fixture from a local server, so the test suite never depends on a
 * 440 MB download or on GitHub being reachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import {
  parseVmRow,
  serviceKey,
  syntheticMemoryPercent,
  buildCsvs,
  streamVms,
} from './fetch-azure-sample.mjs';

/** A real-shaped vmtable line: 11 headerless comma-separated fields. */
const vmLine = ({
  id = 'hash1',
  maxCpu = 91.7,
  avgCpu = 0.72,
  p95 = 20.7,
  category = 'Delay-insensitive',
  cores = 8,
  memoryGb = 32,
} = {}) => `${id},sub,dep,558300,1673700,${maxCpu},${avgCpu},${p95},${category},${cores},${memoryGb}`;

test('parseVmRow reads the documented column order', () => {
  const vm = parseVmRow(vmLine());
  assert.deepEqual(vm, {
    vmId: 'hash1',
    avgCpu: 0.72,
    maxCpu: 91.7,
    cores: 8,
    memoryGb: 32,
    category: 'Delay-insensitive',
  });
});

test('parseVmRow rejects rows it does not understand', () => {
  // Silently accepting these would put nonsense samples in front of someone
  // sizing a real deployment.
  assert.equal(parseVmRow(''), null);
  assert.equal(parseVmRow('too,few,fields'), null);
  assert.equal(parseVmRow(vmLine({ avgCpu: 'n/a' })), null);
  assert.equal(parseVmRow(vmLine({ avgCpu: 140 })), null, 'CPU % above 100');
  assert.equal(parseVmRow(vmLine({ maxCpu: -1 })), null, 'negative CPU %');
  assert.equal(parseVmRow(vmLine({ cores: 0 })), null, 'a VM with no cores');
  assert.equal(parseVmRow(vmLine({ memoryGb: 0 })), null);
});

test('serviceKey groups by category and shape', () => {
  assert.equal(serviceKey(parseVmRow(vmLine())), 'delay-insensitive-8c-32g');
  assert.equal(
    serviceKey(parseVmRow(vmLine({ category: 'Interactive', cores: 2, memoryGb: 4 }))),
    'interactive-2c-4g',
  );
  // Different shapes must not collapse into one service.
  assert.notEqual(
    serviceKey(parseVmRow(vmLine({ cores: 2 }))),
    serviceKey(parseVmRow(vmLine({ cores: 8 }))),
  );
});

test('synthetic memory stays in range and keeps peak above average', () => {
  for (const [avg, max] of [[0, 0], [0.5, 91], [50, 60], [100, 100]]) {
    const mem = syntheticMemoryPercent(avg, max);
    assert.ok(mem.avg >= 0 && mem.avg <= 100, `avg ${mem.avg} in range`);
    assert.ok(mem.peak >= 0 && mem.peak <= 100, `peak ${mem.peak} in range`);
    assert.ok(mem.peak > mem.avg, 'a peak below the average is not a peak');
  }
});

test('synthetic memory is deterministic', () => {
  // Two runs of the loader must produce the same file, or nobody can reproduce
  // a recommendation they are looking at.
  assert.deepEqual(syntheticMemoryPercent(12, 40), syntheticMemoryPercent(12, 40));
});

test('buildCsvs emits the columns the app requires', () => {
  const vms = Array.from({ length: 4 }, (_, i) =>
    parseVmRow(vmLine({ id: `v${i}`, avgCpu: 10 + i })),
  );
  const { configuration, metrics } = buildCsvs(vms);

  assert.equal(
    configuration.split('\n')[0],
    'Display Name,Cpu Limit,Memory Limit,Min,Max,Current,Desired',
  );
  assert.equal(
    metrics.split('\n')[0],
    'Container Name,Cpu %,Max Cpu %,Avg Memory %,Max Memory %',
  );

  // Every metrics row must name a service that exists in the config, or the
  // upload joins to nothing.
  const names = new Set(
    configuration.trim().split('\n').slice(1).map((l) => l.split(',')[0]),
  );
  for (const row of metrics.trim().split('\n').slice(1)) {
    assert.ok(names.has(row.split(',')[0]), `unmatched service ${row}`);
  }
});

test('buildCsvs drops groups with a single sample', () => {
  // One machine says nothing about variance, and sizing off it is exactly the
  // mistake this tool is supposed to prevent.
  const vms = [parseVmRow(vmLine({ id: 'lonely', cores: 64, memoryGb: 256 }))];
  const built = buildCsvs(vms);
  assert.equal(built.serviceCount, 0);
  assert.equal(built.sampleCount, 0);
});

test('buildCsvs respects the service and sample caps', () => {
  const vms = [];
  for (let c = 1; c <= 20; c += 1) {
    for (let i = 0; i < 10; i += 1) {
      vms.push(parseVmRow(vmLine({ id: `v${c}-${i}`, cores: c })));
    }
  }
  const built = buildCsvs(vms, { maxServices: 3, samplesPerService: 4 });
  assert.equal(built.serviceCount, 3);
  assert.equal(built.sampleCount, 12);
});

test('--cpu-only leaves the memory columns blank rather than inventing them', () => {
  const vms = Array.from({ length: 3 }, (_, i) => parseVmRow(vmLine({ id: `v${i}` })));
  const { metrics } = buildCsvs(vms, { cpuOnly: true });
  const row = metrics.trim().split('\n')[1].split(',');
  assert.equal(row[3], '');
  assert.equal(row[4], '');
});

test('streamVms stops once it has enough rows', async () => {
  const body = gzipSync(
    Array.from({ length: 500 }, (_, i) => vmLine({ id: `v${i}` })).join('\n') + '\n',
  );
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/vmtable.csv.gz`;

  try {
    const vms = await streamVms(url, { rowsWanted: 10 });
    // Stopping is per-chunk, so it may overshoot within a chunk. What matters
    // is that it stops rather than reading all 500.
    assert.ok(vms.length >= 10, `got ${vms.length}`);
    assert.ok(vms.length < 500, 'did not read the whole file');
  } finally {
    server.close();
  }
});

test('streamVms reports an HTTP failure instead of writing an empty file', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/missing.csv.gz`;

  try {
    await assert.rejects(
      () => streamVms(url, { rowsWanted: 10 }),
      /404/,
    );
  } finally {
    server.close();
  }
});
