import type { StaticSimpleSchema, StaticStructureSchema } from "@smithy/types";
import { bench, describe } from "vitest";

import { NormalizedSchema } from "./NormalizedSchema";
import { translateTraits } from "./translateTraits";

/**
 * Benchmarks for NormalizedSchema.of() and translateTraits() caching.
 *
 * Run with:
 *   npx vitest bench packages/core/src/submodules/schema/schemas/NormalizedSchema.bench.ts
 */

// --- Fixtures ---

const simpleSchema: StaticSimpleSchema = [0, "com.example", "MyString", 0, 0];

const structSchema: StaticStructureSchema = [
  3,
  "com.example",
  "GetItemOutput",
  0b0000_0010,
  ["id", "name", "count", "active", "tags"],
  [
    [simpleSchema, 0b0000_0001],
    [simpleSchema, 0b0000_1000],
    [1, 0],
    [2, 0],
    [simpleSchema, 0],
  ],
];

// Simulate a lazy schema ref (function that returns a schema)
const lazyStructRef = () => structSchema;

// --- Cache hit vs. cache miss comparison ---

describe("NormalizedSchema.of() — cached vs uncached struct construction", () => {
  // Warm the cache for the shared struct
  NormalizedSchema.of(structSchema);

  bench("cache HIT (same struct reference)", () => {
    NormalizedSchema.of(structSchema);
  });

  bench("cache MISS (unique struct each call)", () => {
    // Create a structurally identical but referentially distinct schema
    // so the WeakMap never hits. This measures the real construction cost.
    const fresh: StaticStructureSchema = [
      3,
      "com.example",
      "GetItemOutput",
      0b0000_0010,
      ["id", "name", "count", "active", "tags"],
      [
        [simpleSchema, 0b0000_0001],
        [simpleSchema, 0b0000_1000],
        [1, 0],
        [2, 0],
        [simpleSchema, 0],
      ],
    ];
    NormalizedSchema.of(fresh);
  });
});

// --- NormalizedSchema.of() benchmarks ---

describe("NormalizedSchema.of() — cache hit (object schema)", () => {
  // Warm the cache
  NormalizedSchema.of(structSchema);

  bench("cached lookup", () => {
    NormalizedSchema.of(structSchema);
  });
});

describe("NormalizedSchema.of() — cache hit via lazy ref", () => {
  // Warm the cache (deref + cache store)
  NormalizedSchema.of(lazyStructRef);

  bench("cached lookup through function deref", () => {
    NormalizedSchema.of(lazyStructRef);
  });
});

describe("NormalizedSchema.of() — identity pass-through", () => {
  const ns = NormalizedSchema.of(structSchema);

  bench("instanceof short-circuit", () => {
    NormalizedSchema.of(ns);
  });
});

describe("NormalizedSchema.of() — primitive schema (no cache)", () => {
  bench("primitive (number) construction", () => {
    NormalizedSchema.of(0);
  });
});

describe("NormalizedSchema.of() — struct member iteration (cached parent)", () => {
  // Warm the cache
  NormalizedSchema.of(structSchema);

  bench("of() + structIterator", () => {
    const ns = NormalizedSchema.of(structSchema);
    for (const [_name, _member] of ns.structIterator()) {
      // iterate all members
    }
  });
});

// --- translateTraits() benchmarks ---

describe("translateTraits() — cache hit (numeric bitmask)", () => {
  // Warm the cache
  translateTraits(0b0000_0101);

  bench("cached bitmask lookup", () => {
    translateTraits(0b0000_0101);
  });
});

describe("translateTraits() — cached vs uncached bitmask", () => {
  // Warm the cache
  translateTraits(0b0000_0011);

  bench("cache HIT (same bitmask)", () => {
    translateTraits(0b0000_0011);
  });

  bench("cache MISS (unique bitmask each call)", () => {
    // Use a random large number that won't be in the cache.
    // The Map.get() misses, so full trait decoding runs.
    const bitmask = (Math.random() * 0x7fffffff) | 0;
    translateTraits(bitmask);
  });
});

describe("translateTraits() — object passthrough", () => {
  const obj = { sensitive: 1 } as const;

  bench("object indicator passthrough", () => {
    translateTraits(obj);
  });
});

// --- Simulated hot-path: repeated serialization setup ---

describe("simulated hot path — repeated of() + getMergedTraits()", () => {
  // Warm the cache
  NormalizedSchema.of(structSchema);

  bench("of() + getMergedTraits() (cached)", () => {
    const ns = NormalizedSchema.of(structSchema);
    ns.getMergedTraits();
  });
});

describe("simulated hot path — 10 sequential of() calls (mixed schemas)", () => {
  const schemas = [
    structSchema,
    simpleSchema,
    structSchema,
    simpleSchema,
    structSchema,
    simpleSchema,
    structSchema,
    simpleSchema,
    structSchema,
    simpleSchema,
  ];

  // Warm caches
  schemas.forEach((s) => NormalizedSchema.of(s));

  bench("10x of() mixed schemas", () => {
    for (const s of schemas) {
      NormalizedSchema.of(s);
    }
  });
});
