/**
 * Tests for the sizing recommendations.
 *
 * These numbers get applied to production deployments, so the tests pin the
 * boundaries rather than sampling the middle of each band: an off-by-one at a
 * threshold silently re-sizes every service that sits on it.
 */

import {
  JAVA_RULES,
  calculatePodRecommendations,
  calculateJavaRecommendations,
  getRecommendationType,
} from './recommendations';

/** One usage sample. Defaults describe an idle service. */
const sample = (overrides = {}) => ({
  cpuPercent: 1,
  avgMemoryPercent: 10,
  maxCpuPercent: 5,
  maxMemoryPercent: 20,
  ...overrides,
});

const current = (overrides = {}) => ({
  cpuLimit: 4,
  memoryLimit: 8,
  currentPods: 5,
  ...overrides,
});

describe('calculatePodRecommendations', () => {
  test('very low usage reduces replicas hard', () => {
    expect(calculatePodRecommendations(2, 10, 5, 10, 10)).toBe(4);
  });

  test('high usage adds replicas', () => {
    expect(calculatePodRecommendations(60, 95, 70, 90, 10)).toBe(12);
  });

  test('moderate usage leaves the count alone', () => {
    expect(calculatePodRecommendations(30, 85, 40, 75, 6)).toBe(6);
  });

  test('never recommends zero replicas', () => {
    // Math.ceil(1 * 0.4) is 1, but a future coefficient change must not be
    // able to take a running service to zero.
    expect(calculatePodRecommendations(0, 0, 0, 0, 1)).toBeGreaterThanOrEqual(1);
  });

  describe('HPA bounds', () => {
    test('a reduction is not taken below the HPA floor', () => {
      // Without this the plan says 4 while the HPA immediately scales back to
      // 8, so the predicted saving never materialises.
      expect(calculatePodRecommendations(1, 5, 5, 10, 10, { minPods: 8 })).toBe(8);
    });

    test('an increase is not taken above the HPA ceiling', () => {
      expect(calculatePodRecommendations(60, 95, 70, 90, 10, { maxPods: 11 })).toBe(11);
    });

    test('bounds that do not bind leave the recommendation untouched', () => {
      expect(calculatePodRecommendations(1, 5, 5, 10, 10, { minPods: 1, maxPods: 50 })).toBe(4);
    });

    test('bounds arriving as strings still apply', () => {
      // A CSV column that is not dynamically typed hands over "8", and a
      // skipped clamp is invisible in the output.
      expect(calculatePodRecommendations(1, 5, 5, 10, 10, { minPods: '8' })).toBe(8);
    });

    test('non-numeric bounds are ignored rather than producing NaN', () => {
      expect(calculatePodRecommendations(1, 5, 5, 10, 10, { minPods: 'n/a' })).toBe(4);
    });

    test('absent bounds are ignored rather than treated as zero', () => {
      expect(calculatePodRecommendations(1, 5, 5, 10, 10, {})).toBe(4);
      expect(calculatePodRecommendations(1, 5, 5, 10, 10)).toBe(4);
    });
  });
});

describe('calculateJavaRecommendations — CPU bands', () => {
  const cpuFor = (cpuPercent) =>
    calculateJavaRecommendations([sample({ cpuPercent })], current({ cpuLimit: 10 })).cpu;

  test.each([
    [0.5, 2],   // under 1%: 15% of the limit
    [1.5, 3],   // 1-2%: 25%
    [5, 4],     // 2-10%: 40%
    [15, 6],    // 10-20%: 60%
  ])('avg CPU %p%% recommends %i cores', (avg, expected) => {
    expect(cpuFor(avg)).toBe(expected);
  });

  test('moderate CPU keeps the current limit', () => {
    expect(cpuFor(40)).toBe(10);
  });

  test('high CPU scales up using peak plus buffer', () => {
    const result = calculateJavaRecommendations(
      [sample({ cpuPercent: 80, maxCpuPercent: 90 })], current({ cpuLimit: 10 }));
    expect(result.cpu).toBe(Math.ceil(10 * 0.9 * JAVA_RULES.CPU_BUFFER));
  });

  test('never drops below the minimum', () => {
    expect(calculateJavaRecommendations(
      [sample({ cpuPercent: 0 })], current({ cpuLimit: 1 })).cpu,
    ).toBeGreaterThanOrEqual(JAVA_RULES.MIN_CPU);
  });
});

describe('calculateJavaRecommendations — CPU band boundaries', () => {
  // The README claims every boundary is pinned, so pin them: an off-by-one at
  // a threshold silently re-sizes every service sitting exactly on it.
  const cpuFor = (cpuPercent) =>
    calculateJavaRecommendations([sample({ cpuPercent })], current({ cpuLimit: 10 })).cpu;

  test.each([
    [0.999, 2],  // just under 1%
    [1, 3],      // exactly 1% leaves the <1% band
    [1.999, 3],
    [2, 4],      // exactly 2% leaves the <2% band
    [9.999, 4],
    [10, 6],     // exactly 10% leaves the <10% band
    [19.999, 6],
    [20, 10],    // exactly 20% is no longer a reduction
    [70, 10],    // exactly 70% is not yet the scale-up branch
  ])('avg CPU %p%% recommends %i', (avg, expected) => {
    expect(cpuFor(avg)).toBe(expected);
  });

  test('just past 70% enters the scale-up branch', () => {
    const result = calculateJavaRecommendations(
      [sample({ cpuPercent: 70.1, maxCpuPercent: 95 })], current({ cpuLimit: 10 }));
    expect(result.cpu).toBeGreaterThan(10);
  });

  test('a scale-up branch never returns less than the current limit', () => {
    // peak% x 1.3 is below 1.0 for any peak under ~77%, so this branch used to
    // recommend a REDUCTION for a service averaging over 70%.
    const result = calculateJavaRecommendations(
      [sample({ cpuPercent: 71, maxCpuPercent: 71 })], current({ cpuLimit: 100 }));
    expect(result.cpu).toBeGreaterThanOrEqual(100);
  });
});

describe('calculateJavaRecommendations — memory band boundaries', () => {
  const memoryFor = (avgMemoryPercent) =>
    calculateJavaRecommendations(
      [sample({ avgMemoryPercent })], current({ memoryLimit: 20 })).memory;

  test.each([
    [14.999, 8],
    [15, 10],    // exactly 15% leaves the <15% band
    [19.999, 10],
    [20, 12],    // exactly 20% leaves the <20% band
    [29.999, 12],
    [30, 20],    // exactly 30% is no longer a reduction
    [80, 20],    // exactly 80% is not yet the scale-up branch
  ])('avg memory %p%% recommends %iGB', (avg, expected) => {
    expect(memoryFor(avg)).toBe(expected);
  });

  test('a memory scale-up never returns less than the current limit', () => {
    const result = calculateJavaRecommendations(
      [sample({ avgMemoryPercent: 81, maxMemoryPercent: 81 })],
      current({ memoryLimit: 100 }));
    expect(result.memory).toBeGreaterThanOrEqual(100);
  });
});

describe('calculateJavaRecommendations — memory bands', () => {
  const memoryFor = (avgMemoryPercent) =>
    calculateJavaRecommendations(
      [sample({ avgMemoryPercent })], current({ memoryLimit: 20 })).memory;

  test.each([
    [10, 8],    // under 15%: 35%
    [17, 10],   // 15-20%: 50%
    [25, 12],   // 20-30%: 60%
  ])('avg memory %p%% recommends %iGB', (avg, expected) => {
    expect(memoryFor(avg)).toBe(expected);
  });

  test('moderate memory keeps the current limit', () => {
    expect(memoryFor(50)).toBe(20);
  });

  test('the result is always even', () => {
    // Odd heap sizes make the JVM arithmetic awkward, so the code rounds up.
    for (const avg of [10, 17, 25, 50]) {
      expect(memoryFor(avg) % 2).toBe(0);
    }
  });

  test('never drops below the minimum', () => {
    expect(calculateJavaRecommendations(
      [sample({ avgMemoryPercent: 0 })], current({ memoryLimit: 1 })).memory,
    ).toBeGreaterThanOrEqual(JAVA_RULES.MIN_MEMORY);
  });
});

describe('calculateJavaRecommendations — no data', () => {
  test('empty usage keeps the current sizing', () => {
    // A missing metrics export must not read as "this service is idle".
    const result = calculateJavaRecommendations([], current());
    expect(result).toEqual({ cpu: 4, memory: 8, pods: 5 });
  });

  test('averages several samples rather than using the first', () => {
    const usage = [sample({ cpuPercent: 0 }), sample({ cpuPercent: 30 })];
    // Mean is 15%, which lands in the 10-20% band: 60% of the limit.
    expect(calculateJavaRecommendations(usage, current({ cpuLimit: 10 })).cpu).toBe(6);
  });

  test('peaks come from the highest sample, not the last', () => {
    const usage = [
      sample({ cpuPercent: 80, maxCpuPercent: 99 }),
      sample({ cpuPercent: 80, maxCpuPercent: 10 }),
    ];
    const result = calculateJavaRecommendations(usage, current({ cpuLimit: 10 }));
    expect(result.cpu).toBe(Math.ceil(10 * 0.99 * JAVA_RULES.CPU_BUFFER));
  });
});

describe('getRecommendationType', () => {
  test('growing limits under high usage is SCALE_UP', () => {
    expect(getRecommendationType(90, 50, 2, 0)).toBe('SCALE_UP');
  });

  test('growing limits under ordinary usage is OPTIMIZE_UP', () => {
    expect(getRecommendationType(30, 30, 2, 0)).toBe('OPTIMIZE_UP');
  });

  test('shrinking limits is SCALE_DOWN', () => {
    expect(getRecommendationType(5, 5, -2, -4)).toBe('SCALE_DOWN');
  });

  test('no change at all is OPTIMAL', () => {
    expect(getRecommendationType(40, 40, 0, 0, 0)).toBe('OPTIMAL');
  });

  describe('pod-only changes', () => {
    test('adding replicas is not OPTIMAL', () => {
      // Previously this returned OPTIMAL, hiding every pod-only change.
      expect(getRecommendationType(40, 40, 0, 0, 3)).toBe('SCALE_UP');
    });

    test('removing replicas is not OPTIMAL', () => {
      expect(getRecommendationType(10, 10, 0, 0, -3)).toBe('SCALE_DOWN');
    });
  });
});
