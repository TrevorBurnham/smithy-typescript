/**
 * End-to-end benchmark: NormalizedSchema in realistic serde paths.
 *
 * Simulates the actual call patterns that occur during serialization and
 * deserialization of AWS SDK operations, using schema shapes modeled after
 * real services (DynamoDB-style nested/recursive structures, S3-style flat
 * HTTP-binding structures, and batch operations).
 *
 * Usage: run this benchmark on two branches and compare the numbers.
 *
 *   # on main (baseline)
 *   npx vitest bench --run src/submodules/schema/schemas/NormalizedSchema.e2e.bench.ts
 *
 *   # on feat/normalized-schema-caching
 *   npx vitest bench --run src/submodules/schema/schemas/NormalizedSchema.e2e.bench.ts
 *
 * The E2E serde benchmarks use static schema refs (the realistic case),
 * so the difference between branches reflects the actual impact of caching
 * on top of the existing structIterator cache.
 */
import { bench, describe } from "vitest";

import type {
  StaticListSchema,
  StaticMapSchema,
  StaticStructureSchema,
  StaticUnionSchema,
} from "@smithy/types";

import { NormalizedSchema } from "./NormalizedSchema";

// ---------------------------------------------------------------------------
// Schema fixtures — modeled after real AWS service shapes
// ---------------------------------------------------------------------------

/**
 * DynamoDB-style AttributeValue: a recursive union with 8 variants.
 * This is the canonical "deeply nested, highly recursive" schema that
 * kuhe referenced. Each value in a DynamoDB item is an AttributeValue,
 * and items can nest maps-of-maps-of-lists arbitrarily deep.
 */
const AttributeValue: StaticUnionSchema = [
  4,
  "com.amazonaws.dynamodb",
  "AttributeValue",
  0,
  ["S", "N", "B", "SS", "NS", "BS", "M", "L", "NULL", "BOOL"],
  [
    0,                                                    // S  → string
    0,                                                    // N  → string (numeric)
    21,                                                   // B  → blob
    [1, "com.amazonaws.dynamodb", "StringSet", 0, 0],     // SS → list<string>
    [1, "com.amazonaws.dynamodb", "NumberSet", 0, 0],     // NS → list<string>
    [1, "com.amazonaws.dynamodb", "BinarySet", 0, 21],    // BS → list<blob>
    () => AttributeValueMap,                              // M  → map<AttributeValue> (recursive)
    () => AttributeValueList,                             // L  → list<AttributeValue> (recursive)
    2,                                                    // NULL → boolean
    2,                                                    // BOOL → boolean
  ],
];

const AttributeValueMap: StaticMapSchema = [
  2, "com.amazonaws.dynamodb", "AttributeValueMap", 0, 0, () => AttributeValue,
];

const AttributeValueList: StaticListSchema = [
  1, "com.amazonaws.dynamodb", "AttributeValueList", 0, () => AttributeValue,
];

/**
 * DynamoDB GetItem output — a struct wrapping a map of AttributeValues.
 */
const GetItemOutput: StaticStructureSchema = [
  3,
  "com.amazonaws.dynamodb",
  "GetItemOutput",
  0,
  ["Item", "ConsumedCapacity"],
  [
    [() => AttributeValueMap, 0],
    [() => ConsumedCapacity, 0],
  ],
];

const ConsumedCapacity: StaticStructureSchema = [
  3,
  "com.amazonaws.dynamodb",
  "ConsumedCapacity",
  0,
  ["TableName", "CapacityUnits", "ReadCapacityUnits", "WriteCapacityUnits"],
  [0, 1, 1, 1],
];

/**
 * DynamoDB BatchGetItem — processes up to 100 items per call, each with
 * its own AttributeValue map. This is the shape that maximizes the number
 * of NormalizedSchema.of() calls per operation.
 */
const BatchGetItemOutput: StaticStructureSchema = [
  3,
  "com.amazonaws.dynamodb",
  "BatchGetItemOutput",
  0,
  ["Responses", "UnprocessedKeys"],
  [
    // Responses: map<string, list<map<string, AttributeValue>>>
    [2, "com.amazonaws.dynamodb", "BatchGetResponseMap", 0, 0,
      [1, "com.amazonaws.dynamodb", "ItemList", 0, () => AttributeValueMap]],
    // UnprocessedKeys (simplified)
    0,
  ],
];

/**
 * S3-style GetObjectOutput — flat struct with many HTTP-bound members.
 * Most members have httpHeader traits, so structIterator touches every
 * member but the serializer only writes a few to the body.
 */
const GetObjectOutput: StaticStructureSchema = [
  3,
  "com.amazonaws.s3",
  "GetObjectOutput",
  0,
  [
    "Body", "ContentLength", "ContentType", "ContentEncoding",
    "ETag", "LastModified", "VersionId", "CacheControl",
    "ContentDisposition", "ContentLanguage", "ContentRange",
    "Expires", "ServerSideEncryption", "Metadata", "StorageClass",
    "RequestCharged", "ReplicationStatus", "PartsCount",
    "ObjectLockMode", "ObjectLockRetainUntilDate",
  ],
  [
    [42, 0b0001_0000],                                   // Body: streaming blob, httpPayload
    [1, { httpHeader: "Content-Length" }],                 // ContentLength
    [0, { httpHeader: "Content-Type" }],                  // ContentType
    [0, { httpHeader: "Content-Encoding" }],              // ContentEncoding
    [0, { httpHeader: "ETag" }],                          // ETag
    [4, { httpHeader: "Last-Modified" }],                 // LastModified: timestamp
    [0, { httpHeader: "x-amz-version-id" }],              // VersionId
    [0, { httpHeader: "Cache-Control" }],                 // CacheControl
    [0, { httpHeader: "Content-Disposition" }],            // ContentDisposition
    [0, { httpHeader: "Content-Language" }],               // ContentLanguage
    [0, { httpHeader: "Content-Range" }],                  // ContentRange
    [4, { httpHeader: "Expires" }],                        // Expires
    [0, { httpHeader: "x-amz-server-side-encryption" }],   // ServerSideEncryption
    [() => MetadataMap, { httpPrefixHeaders: "x-amz-meta-" }], // Metadata
    [0, { httpHeader: "x-amz-storage-class" }],            // StorageClass
    [0, { httpHeader: "x-amz-request-charged" }],          // RequestCharged
    [0, { httpHeader: "x-amz-replication-status" }],       // ReplicationStatus
    [1, { httpHeader: "x-amz-mp-parts-count" }],           // PartsCount
    [0, { httpHeader: "x-amz-object-lock-mode" }],         // ObjectLockMode
    [4, { httpHeader: "x-amz-object-lock-retain-until-date" }], // ObjectLockRetainUntilDate
  ],
];

const MetadataMap: StaticMapSchema = [
  2, "com.amazonaws.s3", "Metadata", 0, 0, 0,
];

// ---------------------------------------------------------------------------
// Helpers — simulate what CborCodec.serialize / readValue actually do
// ---------------------------------------------------------------------------

/**
 * Walks a schema + data pair the same way CborCodec.serialize() does:
 * calls NormalizedSchema.of() at each level, then recurses into struct
 * members (via structIterator), list items, and map entries.
 */
function simulateSerialize(schema: any, data: any): void {
  const ns = NormalizedSchema.of(schema);

  if (data == null) return;

  if (typeof data !== "object") return;

  if (ns.isListSchema() && Array.isArray(data)) {
    const valueSchema = ns.getValueSchema();
    for (const item of data) {
      simulateSerialize(valueSchema, item);
    }
    return;
  }

  if (ns.isMapSchema()) {
    const valueSchema = ns.getValueSchema();
    for (const key of Object.keys(data)) {
      simulateSerialize(valueSchema, data[key]);
    }
    return;
  }

  if (ns.isStructSchema()) {
    for (const [key, memberSchema] of ns.structIterator()) {
      if (data[key] != null) {
        simulateSerialize(memberSchema, data[key]);
      }
    }
    if (ns.isUnionSchema()) {
      // union: only one member is set, handled above
    }
    return;
  }
}

/**
 * Same as simulateSerialize but follows the deserialization path
 * (NormalizedSchema.of() at entry, then structIterator for structs).
 */
function simulateDeserialize(schema: any, data: any): any {
  const ns = NormalizedSchema.of(schema);

  if (data == null) return data;

  if (typeof data !== "object") return data;

  if (ns.isListSchema()) {
    const memberSchema = ns.getValueSchema();
    const result: any[] = [];
    for (const item of data) {
      result.push(simulateDeserialize(memberSchema, item));
    }
    return result;
  }

  if (ns.isMapSchema()) {
    const targetSchema = ns.getValueSchema();
    const result: any = {};
    for (const key of Object.keys(data)) {
      result[key] = simulateDeserialize(targetSchema, data[key]);
    }
    return result;
  }

  if (ns.isStructSchema()) {
    const result: any = {};
    for (const [key, memberSchema] of ns.structIterator()) {
      if (data[key] != null) {
        result[key] = simulateDeserialize(memberSchema, data[key]);
      }
    }
    return result;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Test data — realistic payloads
// ---------------------------------------------------------------------------

/** A single DynamoDB item with mixed attribute types and 2 levels of nesting. */
function makeDynamoItem(id: number) {
  return {
    pk: { S: `USER#${id}` },
    sk: { S: `PROFILE#${id}` },
    name: { S: "Jane Doe" },
    age: { N: "30" },
    active: { BOOL: true },
    tags: { L: [{ S: "admin" }, { S: "verified" }, { S: "premium" }] },
    metadata: {
      M: {
        createdAt: { N: "1700000000" },
        updatedAt: { N: "1700100000" },
        source: { S: "api" },
        nested: {
          M: {
            level2key: { S: "deep-value" },
            level2num: { N: "42" },
          },
        },
      },
    },
    scores: { NS: ["100", "200", "300"] },
    avatar: { NULL: true },
  };
}

/** BatchGetItem response: 25 items (typical page). */
function makeBatchResponse(count: number) {
  const items: any[] = [];
  for (let i = 0; i < count; i++) {
    items.push(makeDynamoItem(i));
  }
  return {
    Responses: {
      UsersTable: items,
    },
    UnprocessedKeys: null,
  };
}

/** GetItem response: single item. */
function makeGetItemResponse(id: number) {
  return {
    Item: makeDynamoItem(id),
    ConsumedCapacity: {
      TableName: "UsersTable",
      CapacityUnits: 5,
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 0,
    },
  };
}

/** S3 GetObject-style response metadata (no body, just header-bound fields). */
const s3GetObjectData = {
  Body: null,
  ContentLength: 1048576,
  ContentType: "application/octet-stream",
  ContentEncoding: "gzip",
  ETag: '"abc123def456"',
  LastModified: new Date("2025-01-15T10:30:00Z"),
  VersionId: "v1.0",
  CacheControl: "max-age=3600",
  ContentDisposition: "attachment",
  ContentLanguage: "en-US",
  ContentRange: "bytes 0-1048575/1048576",
  Expires: new Date("2025-02-15T10:30:00Z"),
  ServerSideEncryption: "AES256",
  Metadata: { "custom-key": "custom-value", "another-key": "another-value" },
  StorageClass: "STANDARD",
  RequestCharged: "requester",
  ReplicationStatus: "COMPLETE",
  PartsCount: 1,
  ObjectLockMode: "GOVERNANCE",
  ObjectLockRetainUntilDate: new Date("2026-01-15T10:30:00Z"),
};

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

// Pre-warm all schema caches so we measure steady-state, not first-call.
simulateSerialize(GetItemOutput, makeGetItemResponse(0));
simulateSerialize(BatchGetItemOutput, makeBatchResponse(1));
simulateSerialize(GetObjectOutput, s3GetObjectData);

describe("E2E serde: DynamoDB GetItem (single item, nested unions)", () => {
  const data = makeGetItemResponse(0);

  bench("serialize", () => {
    simulateSerialize(GetItemOutput, data);
  });

  bench("deserialize", () => {
    simulateDeserialize(GetItemOutput, data);
  });
});

describe("E2E serde: DynamoDB BatchGetItem (25 items)", () => {
  const data = makeBatchResponse(25);

  bench("serialize 25 items", () => {
    simulateSerialize(BatchGetItemOutput, data);
  });

  bench("deserialize 25 items", () => {
    simulateDeserialize(BatchGetItemOutput, data);
  });
});

describe("E2E serde: DynamoDB BatchGetItem (100 items — max page)", () => {
  const data = makeBatchResponse(100);

  bench("serialize 100 items", () => {
    simulateSerialize(BatchGetItemOutput, data);
  });

  bench("deserialize 100 items", () => {
    simulateDeserialize(BatchGetItemOutput, data);
  });
});

describe("E2E serde: S3 GetObjectOutput (20 HTTP-bound members)", () => {
  bench("serialize (structIterator + trait reads)", () => {
    simulateSerialize(GetObjectOutput, s3GetObjectData);
  });

  bench("deserialize (structIterator + trait reads)", () => {
    simulateDeserialize(GetObjectOutput, s3GetObjectData);
  });
});

describe("E2E serde: rapid-fire single-item GetItem (1000 calls)", () => {
  // Simulates a Lambda handler doing 1000 DynamoDB reads in a loop.
  const items = Array.from({ length: 1000 }, (_, i) => makeGetItemResponse(i));

  bench("1000 sequential serialize calls", () => {
    for (const item of items) {
      simulateSerialize(GetItemOutput, item);
    }
  });

  bench("1000 sequential deserialize calls", () => {
    for (const item of items) {
      simulateDeserialize(GetItemOutput, item);
    }
  });
});

describe("NormalizedSchema.of() call-site breakdown", () => {
  // This isolates the NormalizedSchema.of() cost for the top-level schema
  // (the entry point that is NOT covered by structIterator caching).
  // In RpcProtocol and HttpBindingProtocol, NormalizedSchema.of(operationSchema.input)
  // is called once per request — this is the call the cache helps with.

  bench("of(GetItemOutput) — top-level struct (cache hit)", () => {
    NormalizedSchema.of(GetItemOutput);
  });

  bench("of(BatchGetItemOutput) — top-level struct (cache hit)", () => {
    NormalizedSchema.of(BatchGetItemOutput);
  });

  bench("of(GetObjectOutput) — top-level struct (cache hit)", () => {
    NormalizedSchema.of(GetObjectOutput);
  });

  // Lazy ref through a function — this is how recursive schemas are referenced.
  // In generated code, lazy refs are static module-level functions (not fresh
  // closures), so the function object itself is the cache key.
  const lazyRef = () => AttributeValueMap;
  NormalizedSchema.of(lazyRef); // warm
  bench("of(lazyRef) — lazy recursive ref (cache hit)", () => {
    NormalizedSchema.of(lazyRef);
  });

  // Numeric schema — primitive cache path.
  bench("of(0) — string sentinel (primitive cache hit)", () => {
    NormalizedSchema.of(0);
  });

  bench("of(1) — numeric sentinel (primitive cache hit)", () => {
    NormalizedSchema.of(1);
  });
});
