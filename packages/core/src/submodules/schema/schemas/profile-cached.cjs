/**
 * CPU profiling script — WITH CACHING (current branch).
 *
 * Usage:
 *   node --cpu-prof --cpu-prof-dir=./profiles profile-cached.cjs
 */

"use strict";

const { NormalizedSchema, translateTraits } = require("../../../../dist-cjs/submodules/schema/index.js");

// --- Static schemas (reused across iterations, like real operation schemas) ---

const simpleString = [0, "com.example", "MyString", 0, 0];
const simpleNumber = [0, "com.example", "MyNumber", 0, 1];

const innerStruct = [
  3, "com.example", "InnerStruct", 0,
  ["field1", "field2"],
  [[simpleString, 0b0000_0001], [simpleNumber, 0]],
];

const listSchema = [1, "com.example", "StringList", 0, simpleString];
const mapSchema = [2, "com.example", "StringMap", 0, simpleString, simpleString];

const operationOutput = [
  3, "com.example", "GetItemOutput", 0b0000_0010,
  ["id", "name", "count", "active", "tags", "metadata", "nested"],
  [
    [simpleString, 0b0000_0001],
    [simpleString, 0b0000_1000],
    [1, 0],
    [2, 0],
    [listSchema, 0],
    [mapSchema, 0],
    [innerStruct, 0],
  ],
];

const operationInput = [
  3, "com.example", "GetItemInput", 0,
  ["id", "limit", "nextToken"],
  [
    [simpleString, 0b0000_0001],
    [1, 0],
    [simpleString, 0],
  ],
];

// --- Simulate realistic serde hot path ---

function simulateSerialize(schema) {
  const ns = NormalizedSchema.of(schema);
  if (ns.isStructSchema()) {
    for (const [_name, memberSchema] of ns.structIterator()) {
      memberSchema.getMergedTraits();
      if (memberSchema.isStructSchema()) {
        simulateSerialize(memberSchema.getSchema());
      } else if (memberSchema.isListSchema()) {
        memberSchema.getValueSchema().getMergedTraits();
      } else if (memberSchema.isMapSchema()) {
        memberSchema.getKeySchema().getMergedTraits();
        memberSchema.getValueSchema().getMergedTraits();
      }
    }
  }
  return ns;
}

const ITERATIONS = 500_000;
const schemas = [operationOutput, operationInput];

console.log(`Profiling ${ITERATIONS} iterations of simulated serialize/deserialize...`);
console.log(`Mode: CACHED (WeakMap + Map caching enabled)`);
console.log();

// Warm up
for (const schema of schemas) {
  simulateSerialize(schema);
}

const start = performance.now();

for (let i = 0; i < ITERATIONS; i++) {
  for (const schema of schemas) {
    simulateSerialize(schema);
  }
  translateTraits(0b0000_0001);
  translateTraits(0b0000_1000);
  translateTraits(0b0001_0000);
}

const elapsed = performance.now() - start;
const opsPerSec = ((ITERATIONS * schemas.length) / (elapsed / 1000)).toFixed(0);

console.log(`Elapsed: ${elapsed.toFixed(1)}ms`);
console.log(`Throughput: ${opsPerSec} serialize ops/sec`);
