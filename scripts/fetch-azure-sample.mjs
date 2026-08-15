#!/usr/bin/env node
/**
 * Build sample CSVs from the Azure Public Dataset (2019 VM trace).
 *
 *   node scripts/fetch-azure-sample.mjs --out sample-data/azure
 *
 * Why this exists: the CSVs shipped in `sample-data/` are hand-written and show
 * the schema, nothing more. Real traces have the shape that makes a sizing tool
 * interesting: a long tail of near-idle machines, a few pinned ones, and peaks
 * that sit nowhere near the average.
 *
 * The trace is not vendored into this repo. It is CC-BY-4.0, so redistribution
 * would be fine, but the files are hundreds of megabytes. This fetches at run
 * time instead.
 *
 * Source: https://github.com/Azure/AzurePublicDataset (AzurePublicDatasetV2),
 * licensed CC-BY-4.0 by Microsoft. If you publish results derived from it, cite
 * the dataset. The paper is Cortez et al., "Resource Central: Understanding and
 * Predicting Workloads for Improved Resource Management in Large Cloud
 * Platforms", SOSP 2017.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THE OUTPUT
 *
 * Only the CPU figures are real. The trace records, per VM: average CPU, max
 * CPU, p95 max CPU, core count, and memory in GB.
 *
 * It records NO memory utilisation and NO replica counts, because it is a VM
 * trace and those are Kubernetes concepts. Those columns are therefore
 * SYNTHETIC: derived deterministically from the VM's own CPU figures so the
 * output is reproducible and internally consistent, but they are not
 * measurements of anything. Do not present a memory recommendation derived
 * from this file as evidence about real workloads.
 *
 * `--cpu-only` writes the memory columns as blank instead of inventing them.
 * The app requires those columns, so that file will be rejected on upload; the
 * flag is there for when you want the CPU data for something else.
 * ---------------------------------------------------------------------------
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

const BASE =
  'https://github.com/Azure/AzurePublicDataset/releases/download/dataset-v2';
export const VMTABLE_URL = `${BASE}/trace_data_vmtable_vmtable.csv.gz`;

/**
 * vmtable.csv.gz is headerless. Columns, from the dataset's own schema.csv:
 * 0 vm id, 1 subscription id, 2 deployment id, 3 created, 4 deleted,
 * 5 max cpu, 6 avg cpu, 7 p95 max cpu, 8 vm category, 9 core count,
 * 10 memory GB.
 */
export const COL = {
  VM_ID: 0,
  MAX_CPU: 5,
  AVG_CPU: 6,
  P95_MAX_CPU: 7,
  CATEGORY: 8,
  CORES: 9,
  MEMORY_GB: 10,
};

/** Parse one vmtable line. Returns null for anything malformed. */
export const parseVmRow = (line) => {
  const f = line.split(',');
  if (f.length < 11) return null;

  const num = (i) => {
    const n = Number(f[i]);
    return Number.isFinite(n) ? n : null;
  };

  const avgCpu = num(COL.AVG_CPU);
  const maxCpu = num(COL.MAX_CPU);
  const cores = num(COL.CORES);
  const memoryGb = num(COL.MEMORY_GB);
  if (avgCpu === null || maxCpu === null || cores === null || memoryGb === null) {
    return null;
  }
  // A percentage outside 0-100, or a machine with no cores, means a row we do
  // not understand. Dropping it is better than emitting a nonsense sample.
  if (avgCpu < 0 || avgCpu > 100 || maxCpu < 0 || maxCpu > 100) return null;
  if (cores <= 0 || memoryGb <= 0) return null;

  const category = (f[COL.CATEGORY] || 'Unknown').trim();
  return { vmId: f[COL.VM_ID], avgCpu, maxCpu, cores, memoryGb, category };
};

/**
 * Group key for a synthetic "service".
 *
 * A VM trace has no services in it. Grouping by workload category and shape
 * gives something a sizing tool can chew on, where each VM in the group becomes
 * one usage sample. The grouping is our construct; the CPU numbers inside it
 * are the trace's.
 */
export const serviceKey = (vm) =>
  `${vm.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${vm.cores}c-${vm.memoryGb}g`;

/**
 * Stand in for the memory utilisation the trace does not contain.
 *
 * Deterministic, so two runs produce the same file. Memory tracks CPU loosely
 * with a floor, which is roughly how a JVM behaves: heap stays allocated when
 * the service goes quiet. This is a plausible shape, not a measurement.
 */
export const syntheticMemoryPercent = (avgCpu, maxCpu) => {
  const avg = Math.min(95, Math.max(8, avgCpu * 0.9 + 12));
  const peak = Math.min(99, Math.max(avg + 5, maxCpu * 0.75 + 15));
  return { avg: Number(avg.toFixed(2)), peak: Number(peak.toFixed(2)) };
};

/**
 * Turn collected VMs into the two CSVs the app reads.
 *
 * @param vms      parsed vmtable rows
 * @param options  { maxServices, samplesPerService, cpuOnly }
 */
export const buildCsvs = (vms, { maxServices = 12, samplesPerService = 8, cpuOnly = false } = {}) => {
  const groups = new Map();
  for (const vm of vms) {
    const key = serviceKey(vm);
    if (!groups.has(key)) {
      if (groups.size >= maxServices) continue;
      groups.set(key, []);
    }
    const rows = groups.get(key);
    if (rows.length < samplesPerService) rows.push(vm);
  }

  // A group with a single sample tells the tool nothing about variance, so it
  // is dropped rather than sized off one machine.
  const usable = [...groups.entries()].filter(([, rows]) => rows.length >= 2);

  const configRows = [];
  const metricRows = [];

  for (const [name, rows] of usable) {
    const cores = rows[0].cores;
    const memoryGb = rows[0].memoryGb;
    // Min/Max/Current/Desired are synthetic: the trace has no replica concept.
    // Deriving the count from the group's own load at least makes the fleet
    // uneven, which is what a sizing tool has to cope with. Taking rows.length
    // instead gave every service the same replica count and the same HPA
    // bounds, so the output looked uniform in a way no real cluster is.
    const meanCpu = rows.reduce((sum, vm) => sum + vm.avgCpu, 0) / rows.length;
    const pods = Math.max(2, Math.min(12, Math.round(meanCpu / 6) + 2));
    configRows.push([name, cores, memoryGb, Math.max(1, pods - 1), pods * 3, pods, pods]);

    for (const vm of rows) {
      if (cpuOnly) {
        metricRows.push([name, vm.avgCpu.toFixed(2), vm.maxCpu.toFixed(2), '', '']);
      } else {
        const mem = syntheticMemoryPercent(vm.avgCpu, vm.maxCpu);
        metricRows.push([name, vm.avgCpu.toFixed(2), vm.maxCpu.toFixed(2), mem.avg, mem.peak]);
      }
    }
  }

  const toCsv = (header, rows) =>
    [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';

  return {
    configuration: toCsv(
      ['Display Name', 'Cpu Limit', 'Memory Limit', 'Min', 'Max', 'Current', 'Desired'],
      configRows,
    ),
    metrics: toCsv(
      ['Container Name', 'Cpu %', 'Max Cpu %', 'Avg Memory %', 'Max Memory %'],
      metricRows,
    ),
    serviceCount: usable.length,
    sampleCount: metricRows.length,
  };
};

/**
 * Stream the gzipped vmtable and stop as soon as enough rows are collected.
 *
 * The file is roughly 440 MB. Aborting the request once the quota is met keeps
 * the actual transfer to a few megabytes, which is the whole reason this reads
 * the stream rather than downloading first.
 */
export const streamVms = async (url, { rowsWanted, signalFactory = () => new AbortController() } = {}) => {
  const controller = signalFactory();
  const res = await fetch(url, { signal: controller.signal });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const vms = [];
  let carry = '';
  let done = false;

  const collect = new Writable({
    write(chunk, _enc, cb) {
      if (done) return cb();
      const text = carry + chunk.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        const vm = parseVmRow(line);
        if (vm) vms.push(vm);
        if (vms.length >= rowsWanted) {
          done = true;
          break;
        }
      }
      if (done) controller.abort();
      cb();
    },
  });

  try {
    await pipeline(res.body, createGunzip(), collect);
  } catch (err) {
    // An abort after the quota is met is the success path, not a failure.
    if (!done) throw err;
  }
  return vms;
};

const parseArgs = (argv) => {
  const opts = { out: 'sample-data/azure', services: 12, samples: 8, cpuOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--services') opts.services = Number(argv[++i]);
    else if (a === '--samples') opts.samples = Number(argv[++i]);
    else if (a === '--cpu-only') opts.cpuOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
};

const main = async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'Usage: node scripts/fetch-azure-sample.mjs [--out DIR] [--services N] [--samples N] [--cpu-only]',
    );
    return 0;
  }

  // Over-fetch: many rows are dropped by validation, and grouping discards
  // singleton groups.
  const rowsWanted = Math.max(2000, opts.services * opts.samples * 40);

  console.log(`Streaming ${VMTABLE_URL}`);
  console.log('(the file is ~440 MB; the stream is aborted once enough rows arrive)');
  const vms = await streamVms(VMTABLE_URL, { rowsWanted });
  console.log(`Collected ${vms.length} VM records.`);

  const built = buildCsvs(vms, {
    maxServices: opts.services,
    samplesPerService: opts.samples,
    cpuOnly: opts.cpuOnly,
  });

  await mkdir(opts.out, { recursive: true });
  const configPath = path.join(opts.out, 'configuration.csv');
  const metricsPath = path.join(opts.out, 'metrics.csv');
  await pipeline([built.configuration], createWriteStream(configPath));
  await pipeline([built.metrics], createWriteStream(metricsPath));

  console.log(`Wrote ${built.serviceCount} services, ${built.sampleCount} samples:`);
  console.log(`  ${configPath}`);
  console.log(`  ${metricsPath}`);
  console.log('');
  console.log('CPU figures come from the Azure trace. Memory utilisation and');
  console.log('replica counts are synthetic: the trace contains neither.');
  console.log('Data: Azure Public Dataset V2, Microsoft, CC-BY-4.0.');
  return 0;
};

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    },
  );
}
