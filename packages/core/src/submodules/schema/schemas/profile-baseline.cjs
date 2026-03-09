/**
 * CPU profiling script — BASELINE (cache always misses).
 *
 * Creates fresh schema arrays each iteration so the WeakMap never hits.
 *
 * Usage:
 *   node --cpu-prof --cpu-prof-dir=./profiles profile-baseline.cjs
 */

"use strict";

const { NormalizedSchema, translateTraits } = require("../../../../dist-cjs/submodules/schema/index.js");

// --- Schema factories (fresh arrays each call to defeat WeakMap cache) ---

function makeSimpleString() { return [0, "com.example", "MyString", 0, 0]; }
function makeSimpleNumber() { return [0, "com.example", "MyNumber", 0, 1]; }

function makeInnerStruct() {
  return [
    3, "com.example", "InnerStruct", 0,
    ["field1", "field2"],
    [[makeSimpleString(), 0b0000_0001], [makeSimpleNumber(), 0]],
  ];
}

function makeListSchema() { return [1, "com.example", "StringList", 0, makeSimpleString()]; }
function makeMapSchema() { return [2, "com.example", "StringMap", 0, makeSimpleString(), makeSimpleString()]; }

function makeOperationOutput() {
  return [
    3, "com.example", "GetItemOutput", 0b0000_0010,
    ["id", "name", "count", "active", "tags", "metadata", "nested"],
    [
      [makeSimpleString(), 0b0000_0001],
      [makeSimpleString(), 0b0000_1000],
      [1, 0],
      [2, 0],
      [makeListSchema(), 0],
      [makeMapSchema(), 0],
      [makeInnerStruct(), 0],
    ],
  ];
}

function makeOperationInput() {
  return [
    3, "com.example", "GetItemInput", 0,
    ["id", "limit", "nextToken"],
    [
      [makeSimpleString(), 0b0000_0001],
      [1, 0],
      [makeSimpleString(), 0],
    ],
  ];
}

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

console.log(`Profiling ${ITERATIONS} iterations of simulated serialize/deserialize...`);
console.log(`Mode: BASELINE (fresh schemas each iteration — WeakMap always misses)`);
console.log();

const start = performance.now();

for (let i = 0; i < ITERATIONS; i++) {
  simulateSerialize(makeOperationOutput());
  simulateSerialize(makeOperationInput());

  translateTraits(0b0000_0001);
  translateTraits(0b0000_1000);
  translateTraits(0b0001_0000);
}

const elapsed = performance.now() - start;
const opsPerSec = ((ITERATIONS * 2) / (elapsed / 1000)).toFixed(0);

console.log(`Elapsed: ${elapsed.toFixed(1)}ms`);
console.log(`Throughput: ${opsPerSec} serialize ops/sec`);
