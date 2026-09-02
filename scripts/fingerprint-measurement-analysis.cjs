const SURFACE_NAMES = [
  "fonts",
  "audio",
  "webgl1",
  "webgl2",
  "webgpu",
  "canvas",
  "clientRects",
  "uaClientHints",
  "screenLocale",
  "aggregate",
];

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function surfaceValue(measurement, context, surface) {
  return measurement?.contexts?.[context]?.surfaces?.[surface];
}

function flattenReadings(value, prefix, output) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value) || typeof value !== "object") {
    output[prefix] = value;
    return;
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    output[prefix] = value;
    return;
  }
  for (const key of keys) flattenReadings(value[key], `${prefix}.${key}`, output);
}

function measurementComponents(measurement, context = "document") {
  const components = {};
  for (const surface of SURFACE_NAMES) {
    const value = surfaceValue(measurement, context, surface);
    if (value?.supported !== true || !value.readings) continue;
    flattenReadings(value.readings, surface, components);
  }
  return components;
}

function commonComponentPaths(componentMaps) {
  if (componentMaps.length === 0) return [];
  return Object.keys(componentMaps[0])
    .filter((component) =>
      componentMaps.every((values) => Object.hasOwn(values, component)),
    )
    .sort();
}

function computeStableSubset(profiles, runIndex, context = "document") {
  const componentMaps = profiles.map((profile) =>
    measurementComponents(profile.runs[runIndex], context),
  );
  return commonComponentPaths(componentMaps).filter((component) =>
    componentMaps.every(
      (values) => canonical(values[component]) === canonical(componentMaps[0][component]),
    ),
  );
}

function findPairCollisions(profiles, runIndex, components, context = "document") {
  if (components.length === 0) return [];
  const componentMaps = profiles.map((profile) =>
    measurementComponents(profile.runs[runIndex], context),
  );
  const collisions = [];
  for (let left = 0; left < profiles.length; left += 1) {
    for (let right = left + 1; right < profiles.length; right += 1) {
      const same = components.every(
        (component) =>
          Object.hasOwn(componentMaps[left], component) &&
          Object.hasOwn(componentMaps[right], component) &&
          canonical(componentMaps[left][component]) === canonical(componentMaps[right][component]),
      );
      if (same) collisions.push([profiles[left].label, profiles[right].label]);
    }
  }
  return collisions;
}

function evaluateConsistency(profiles) {
  const restartMismatches = [];
  const contextMismatches = [];
  const coverageGaps = [];
  const requiredContexts = ["document", "iframe", "worker", "offscreenCanvas"];
  const expectedSurfaces = {
    document: SURFACE_NAMES,
    iframe: SURFACE_NAMES,
    worker: SURFACE_NAMES.filter((surface) => !["audio", "clientRects"].includes(surface)),
    offscreenCanvas: ["canvas", "webgl1", "webgl2", "aggregate"],
  };

  for (const profile of profiles) {
    for (let runIndex = 0; runIndex < profile.runs.length; runIndex += 1) {
      for (const context of requiredContexts) {
        for (const surface of expectedSurfaces[context]) {
          if (surfaceValue(profile.runs[runIndex], context, surface)?.supported !== true) {
            coverageGaps.push({ profile: profile.label, run: runIndex + 1, context, surface });
          }
        }
      }
    }
    for (const context of requiredContexts) {
      for (const surface of SURFACE_NAMES) {
        const first = surfaceValue(profile.runs[0], context, surface);
        const second = surfaceValue(profile.runs[1], context, surface);
        if (first === undefined && second === undefined) continue;
        if (canonical(first) !== canonical(second)) {
          restartMismatches.push({ profile: profile.label, context, surface });
        }
      }
    }

    for (let runIndex = 0; runIndex < profile.runs.length; runIndex += 1) {
      for (const context of requiredContexts.slice(1)) {
        for (const surface of SURFACE_NAMES) {
          if (surface === "aggregate") continue;
          const documentValue = surfaceValue(profile.runs[runIndex], "document", surface);
          const contextValue = surfaceValue(profile.runs[runIndex], context, surface);
          if (!isComparable(documentValue) || !isComparable(contextValue)) continue;
          if (!commonReadingsEqual(documentValue.readings, contextValue.readings)) {
            contextMismatches.push({ profile: profile.label, run: runIndex + 1, context, surface });
          }
        }
      }
    }
  }

  return {
    verdict:
      restartMismatches.length > 0 || contextMismatches.length > 0
        ? "FAIL"
        : coverageGaps.length > 0
          ? "BLOCKED"
          : "PASS",
    restartMismatches,
    contextMismatches,
    coverageGaps,
  };
}

function isComparable(value) {
  return value?.supported === true;
}

function commonReadingsEqual(left, right) {
  const projection = commonProjection(left, right);
  return projection.shared === 0 || canonical(projection.left) === canonical(projection.right);
}

function commonProjection(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return { left, right, shared: 1 };
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return { left, right, shared: 1 };
  }
  const leftOut = {};
  const rightOut = {};
  let shared = 0;
  for (const key of Object.keys(left)
    .filter((candidate) => candidate in right)
    .sort()) {
    if (left[key] === null || right[key] === null) continue;
    const nested = commonProjection(left[key], right[key]);
    if (nested.shared === 0) continue;
    leftOut[key] = nested.left;
    rightOut[key] = nested.right;
    shared += nested.shared;
  }
  return { left: leftOut, right: rightOut, shared };
}

function classifyCohort(profiles, stock) {
  const stockComponents = measurementComponents(stock);
  const profileRuns = profiles.map((profile) =>
    profile.runs.map((measurement) => measurementComponents(measurement)),
  );
  const surfaceGaps = {};
  let hasBlocked = false;
  for (const surface of SURFACE_NAMES) {
    const measuredValues = [
      surfaceValue(stock, "document", surface),
      ...profiles.flatMap((profile) =>
        profile.runs.map((measurement) => surfaceValue(measurement, "document", surface)),
      ),
    ];
    if (measuredValues.some((value) => value?.supported !== true)) {
      surfaceGaps[surface] = { classification: "not-measured", verdict: "BLOCKED" };
      hasBlocked = true;
    }
  }
  const componentNames = [
    ...new Set([
      ...Object.keys(stockComponents),
      ...profileRuns.flatMap((runs) => runs.flatMap((values) => Object.keys(values))),
    ]),
  ].sort();
  const components = {};
  let hasFailure = false;

  for (const component of componentNames) {
    const measuredEverywhere =
      Object.hasOwn(stockComponents, component) &&
      profileRuns.every((runs) =>
        runs.every((values) => Object.hasOwn(values, component)),
      );
    if (!measuredEverywhere) {
      components[component] = { classification: "not-measured", verdict: "BLOCKED" };
      hasBlocked = true;
      continue;
    }
    const stockValue = stockComponents[component];
    const firstRunValues = profileRuns.map((runs) => runs[0][component]);
    const allRunValues = profileRuns.flatMap((runs) => runs.map((values) => values[component]));
    const stableAcrossRestarts = profileRuns.every((runs) =>
      runs.every((values) => canonical(values[component]) === canonical(runs[0][component])),
    );
    const distinctProfiles = new Set(firstRunValues.map(canonical));
    const allMatchStock = allRunValues.every(
      (value) => canonical(value) === canonical(stockValue),
    );
    if (allMatchStock) {
      components[component] = { classification: "matches-stock", verdict: "PASS" };
    } else if (!stableAcrossRestarts) {
      components[component] = { classification: "drifts-across-restarts", verdict: "FAIL" };
      hasFailure = true;
    } else if (distinctProfiles.size > 1) {
      components[component] = { classification: "varies-by-profile", verdict: "PASS" };
    } else {
      components[component] = {
        classification: "invariant-differs-from-stock",
        verdict: "FAIL",
      };
      hasFailure = true;
    }
  }

  const surfaces = summarizeCohortSurfaces(components);
  for (const [surface, gap] of Object.entries(surfaceGaps)) {
    const existing = surfaces[surface];
    if (!existing) {
      surfaces[surface] = gap;
    } else if (existing.verdict !== "FAIL") {
      surfaces[surface] = {
        ...existing,
        verdict: "BLOCKED",
        classifications: { ...existing.classifications, [gap.classification]: 1 },
      };
    }
  }
  return {
    verdict: hasFailure ? "FAIL" : hasBlocked ? "BLOCKED" : "PASS",
    surfaces,
    components,
  };
}

function buildAliasMatrix(profiles, stock, runIndex = 0, context = "document") {
  const matrix = {};
  const stockComponents = measurementComponents(stock, context);
  const profileComponents = profiles.map((profile) =>
    measurementComponents(profile.runs[runIndex], context),
  );
  const componentNames = [
    ...new Set([
      ...Object.keys(stockComponents),
      ...profileComponents.flatMap((values) => Object.keys(values)),
    ]),
  ].sort();
  for (const component of componentNames) {
    const aliases = new Map();
    let next = 1;
    const alias = (value) => {
      const key = canonical(value);
      if (!aliases.has(key)) aliases.set(key, `${surfaceAliasPrefix(component)}${next++}`);
      return aliases.get(key);
    };
    matrix[component] = {
      stock: Object.hasOwn(stockComponents, component) ? alias(stockComponents[component]) : null,
      profiles: profileComponents.map((values) =>
        Object.hasOwn(values, component) ? alias(values[component]) : null,
      ),
    };
  }
  return matrix;
}

function surfaceAliasPrefix(component) {
  return component
    .split(".")[0]
    .split(/(?=[A-Z])/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function analyzeMeasurement({ profiles, stock }) {
  if (profiles.length !== 5)
    throw new Error(`Expected five profiles, received ${profiles.length}.`);
  if (profiles.some((profile) => profile.runs.length !== 2)) {
    throw new Error("Every profile must have exactly two runs.");
  }
  const consistency = evaluateConsistency(profiles);
  const stableSubsets = [0, 1].map((runIndex) => computeStableSubset(profiles, runIndex));
  const criterionB = stableSubsets.map((components, runIndex) => {
    const fullTupleComponents = commonComponentPaths(
      profiles.map((profile) => measurementComponents(profile.runs[runIndex])),
    );
    return {
      run: runIndex + 1,
      stableSubset: components,
      stableSubsetCollisions: findPairCollisions(profiles, runIndex, components),
      fullTupleComponents,
      fullTupleCollisions: findPairCollisions(profiles, runIndex, fullTupleComponents),
    };
  });
  const cohort = classifyCohort(profiles, stock);
  return {
    criterionA: consistency,
    criterionB: {
      verdict: criterionB.every((run) => run.stableSubsetCollisions.length === 0) ? "PASS" : "FAIL",
      runs: criterionB,
    },
    criterionC: cohort,
    aliases: {
      run1: buildAliasMatrix(profiles, stock, 0),
      run2: buildAliasMatrix(profiles, stock, 1),
    },
  };
}

function summarizeCohortSurfaces(components) {
  const grouped = {};
  for (const [component, result] of Object.entries(components)) {
    const surface = component.split(".")[0];
    grouped[surface] ??= { verdict: "PASS", classifications: {}, components: [] };
    grouped[surface].components.push(component);
    grouped[surface].classifications[result.classification] =
      (grouped[surface].classifications[result.classification] ?? 0) + 1;
    if (result.verdict === "FAIL") grouped[surface].verdict = "FAIL";
    else if (result.verdict === "BLOCKED" && grouped[surface].verdict !== "FAIL") {
      grouped[surface].verdict = "BLOCKED";
    }
  }
  return grouped;
}

module.exports = {
  SURFACE_NAMES,
  analyzeMeasurement,
  buildAliasMatrix,
  canonical,
  classifyCohort,
  computeStableSubset,
  evaluateConsistency,
  findPairCollisions,
  measurementComponents,
};
