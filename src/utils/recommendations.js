/**
 * Sizing recommendations for JVM services.
 *
 * This logic used to live inside the JavaServiceOptimizer component, where it
 * could not be tested without rendering the whole UI and uploading two CSVs.
 * It is pure: usage figures in, recommended limits out.
 *
 * The thresholds are deliberately explicit rather than derived. They encode a
 * judgement about how much headroom a JVM needs, and changing one changes
 * every recommendation the tool produces, so they should be changed knowingly.
 */

export const JAVA_RULES = {
  MIN_CPU: 1,
  MIN_MEMORY: 2,
  CPU_BUFFER: 1.3,
  MEMORY_BUFFER: 1.5,
  HIGH_CPU_THRESHOLD: 70,
  HIGH_MEMORY_THRESHOLD: 80,
  LOW_CPU_THRESHOLD: 20,
  LOW_MEMORY_THRESHOLD: 30,
};

/**
 * Recommend a replica count.
 *
 * `bounds` carries the HPA's own min/max. They are respected here rather than
 * only displayed: recommending 2 replicas for a service whose HPA floor is 4
 * produces a plan that the cluster will immediately undo.
 */
export const calculatePodRecommendations = (
  avgCpu, maxCpu, avgMemory, maxMemory, currentPods, bounds = {},
) => {
  let recommended;

  if (avgCpu < 5 && avgMemory < 15 && maxCpu < 50 && maxMemory < 40) {
    recommended = Math.max(1, Math.ceil(currentPods * 0.4));
  } else if (avgCpu < 15 && avgMemory < 25 && maxCpu < 70 && maxMemory < 60) {
    recommended = Math.max(1, Math.ceil(currentPods * 0.6));
  } else if (avgCpu < 25 && avgMemory < 35 && maxCpu < 80 && maxMemory < 70) {
    recommended = Math.max(1, Math.ceil(currentPods * 0.8));
  } else if (avgCpu > 50 || maxCpu > 90 || avgMemory > 60 || maxMemory > 85) {
    recommended = Math.ceil(currentPods * 1.2);
  } else {
    recommended = currentPods;
  }

  // Coerced rather than read directly: a CSV column that arrives as the string
  // "4" would fail Number.isFinite and the bound would be skipped in silence,
  // which is the exact failure this clamp exists to prevent.
  const asBound = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const minPods = asBound(bounds.minPods);
  const maxPods = asBound(bounds.maxPods);
  if (minPods !== null) {
    recommended = Math.max(recommended, minPods);
  }
  if (maxPods !== null) {
    recommended = Math.min(recommended, maxPods);
  }
  return Math.max(1, recommended);
};

/**
 * Recommend CPU and memory limits plus a replica count for one service.
 *
 * @param usage   per-sample figures: { cpuPercent, avgMemoryPercent, maxCpuPercent, maxMemoryPercent }
 * @param current { cpuLimit, memoryLimit, currentPods, minPods, maxPods }
 */
export const calculateJavaRecommendations = (usage, current) => {
  if (!usage || usage.length === 0) {
    // No samples means no evidence. Returning the current sizing is the only
    // honest answer; recommending a reduction from zero data is how a service
    // gets throttled on the strength of a missing metrics export.
    return {
      cpu: Math.max(JAVA_RULES.MIN_CPU, current.cpuLimit),
      memory: Math.max(JAVA_RULES.MIN_MEMORY, current.memoryLimit),
      pods: current.currentPods,
    };
  }

  const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

  const avgCpuPercent = mean(usage.map(u => u.cpuPercent));
  const avgMemoryPercent = mean(usage.map(u => u.avgMemoryPercent));
  const maxCpuPercent = Math.max(...usage.map(u => u.maxCpuPercent));
  const maxMemoryPercent = Math.max(...usage.map(u => u.maxMemoryPercent));

  let recommendedCpu;
  if (avgCpuPercent < 1) {
    recommendedCpu = Math.max(1, Math.ceil(current.cpuLimit * 0.15));
  } else if (avgCpuPercent < 2) {
    recommendedCpu = Math.max(1, Math.ceil(current.cpuLimit * 0.25));
  } else if (avgCpuPercent < 10) {
    recommendedCpu = Math.max(1, Math.ceil(current.cpuLimit * 0.4));
  } else if (avgCpuPercent < JAVA_RULES.LOW_CPU_THRESHOLD) {
    recommendedCpu = Math.max(1, Math.ceil(current.cpuLimit * 0.6));
  } else if (avgCpuPercent > JAVA_RULES.HIGH_CPU_THRESHOLD) {
    // Floor at the current limit. peak% x 1.3 is below 1.0 for any peak under
    // ~77%, so a service averaging 71% with a 71% peak was recommended a
    // REDUCTION from a branch whose whole purpose is scaling up.
    recommendedCpu = Math.max(
      current.cpuLimit,
      Math.ceil((current.cpuLimit * maxCpuPercent / 100) * JAVA_RULES.CPU_BUFFER),
    );
  } else {
    recommendedCpu = current.cpuLimit;
  }

  let recommendedMemory;
  if (avgMemoryPercent < 15) {
    recommendedMemory = Math.max(2, Math.ceil(current.memoryLimit * 0.35));
  } else if (avgMemoryPercent < 20) {
    recommendedMemory = Math.max(2, Math.ceil(current.memoryLimit * 0.5));
  } else if (avgMemoryPercent < JAVA_RULES.LOW_MEMORY_THRESHOLD) {
    recommendedMemory = Math.max(2, Math.ceil(current.memoryLimit * 0.6));
  } else if (avgMemoryPercent > JAVA_RULES.HIGH_MEMORY_THRESHOLD) {
    // Same floor as CPU: the scale-up branch must not shrink the limit.
    recommendedMemory = Math.max(
      current.memoryLimit,
      Math.ceil((current.memoryLimit * maxMemoryPercent / 100) * JAVA_RULES.MEMORY_BUFFER),
    );
  } else {
    recommendedMemory = current.memoryLimit;
  }

  // Even GB values keep the JVM heap arithmetic tidy.
  if (recommendedMemory % 2 !== 0) {
    recommendedMemory += 1;
  }

  const recommendedPods = calculatePodRecommendations(
    avgCpuPercent, maxCpuPercent, avgMemoryPercent, maxMemoryPercent,
    current.currentPods,
    { minPods: current.minPods, maxPods: current.maxPods },
  );

  return {
    cpu: Math.max(JAVA_RULES.MIN_CPU, recommendedCpu),
    memory: Math.max(JAVA_RULES.MIN_MEMORY, recommendedMemory),
    pods: recommendedPods,
  };
};

/**
 * Label a recommendation for the UI.
 *
 * podDiff is included: a plan that changes only the replica count is not
 * OPTIMAL, and labelling it so hid every pod-only change from the reader.
 */
export const getRecommendationType = (avgCpu, avgMemory, cpuDiff, memoryDiff, podDiff = 0) => {
  if (cpuDiff > 0 || memoryDiff > 0) {
    return avgCpu > JAVA_RULES.HIGH_CPU_THRESHOLD || avgMemory > JAVA_RULES.HIGH_MEMORY_THRESHOLD
      ? 'SCALE_UP'
      : 'OPTIMIZE_UP';
  }
  if (cpuDiff < 0 || memoryDiff < 0) {
    return 'SCALE_DOWN';
  }
  if (podDiff > 0) {
    return 'SCALE_UP';
  }
  if (podDiff < 0) {
    return 'SCALE_DOWN';
  }
  return 'OPTIMAL';
};
