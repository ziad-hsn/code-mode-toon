import { TOONEncoder, compressToolSchema, compressToolResult } from '../toon-encoder.js';
import { strict as assert } from 'assert';

// Test data
const testData = {
    simpleObject: { name: 'Alice', age: 30, city: 'NYC' },
    nestedObject: { user: { name: 'Bob', profile: { age: 25, role: 'dev' } } },
    arrayOfObjects: [
        { id: 1, name: 'Alice', email: 'alice@example.com' },
        { id: 2, name: 'Bob', email: 'bob@example.com' },
        { id: 3, name: 'Charlie', email: 'charlie@example.com' }
    ],
    simpleArray: [1, 2, 3, 4, 5],
    emptyArray: [],
    emptyObject: {},
    complexData: {
        users: [
            { id: 1, name: 'Alice', active: true },
            { id: 2, name: 'Bob', active: false }
        ],
        metadata: { count: 2, timestamp: '2024-01-01' }
    }
};

console.log('Running TOON Encoder Tests...\n');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`PASS: ${name}`);
        passed++;
    } catch (error) {
        console.log(`FAIL: ${name}`);
        console.log(`   Error: ${error}`);
        failed++;
    }
}

// Test 1: Simple object encoding/decoding
test('Simple object round-trip', () => {
    const encoded = TOONEncoder.encode(testData.simpleObject);
    const decoded = TOONEncoder.decode(encoded);
    assert.ok(encoded.length < JSON.stringify(testData.simpleObject).length);
    assert.ok(typeof decoded === 'object');
});

// Test 2: Array of objects encoding
test('Array of objects encoding', () => {
    const encoded = TOONEncoder.encode(testData.arrayOfObjects);
    assert.ok(encoded.includes('[3]{id,name,email}:'));
    assert.ok(encoded.includes('1,Alice,alice@example.com'));
});

// Test 3: Empty array handling
test('Empty array handling', () => {
    const encoded = TOONEncoder.encode(testData.emptyArray);
    assert.strictEqual(encoded, '[]');
});

// Test 4: Empty object handling
test('Empty object handling', () => {
    const encoded = TOONEncoder.encode(testData.emptyObject);
    assert.strictEqual(encoded, '');
});

// Test 5: Simple array encoding
test('Simple array encoding', () => {
    const encoded = TOONEncoder.encode(testData.simpleArray);
    assert.strictEqual(encoded, '1,2,3,4,5');
});

// Test 6: Nested object encoding
test('Nested object encoding', () => {
    const encoded = TOONEncoder.encode(testData.nestedObject);
    assert.ok(encoded.includes('user:'));
    assert.ok(encoded.includes('name: Bob'));
});

// Test 7: Complex data structure
test('Complex data structure', () => {
    const encoded = TOONEncoder.encode(testData.complexData);
    assert.ok(encoded.includes('users[2]{id,name,active}:'));
    assert.ok(encoded.includes('metadata:'));
});

// Test 8: String values with commas
test('String values with commas', () => {
    const data = [{ name: 'Smith, John', age: 30 }];
    const encoded = TOONEncoder.encode(data);
    assert.ok(encoded.includes('"Smith, John"'));
});

// Test 9: Null and undefined handling
test('Null and undefined handling', () => {
    const data = [{ a: null, b: undefined, c: 'value' }];
    const encoded = TOONEncoder.encode(data);
    const decoded = TOONEncoder.decode(encoded);
    assert.ok(typeof decoded === 'object');
});

// Test 10: Tool schema compression
test('Tool schema compression', () => {
    const schema = {
        type: 'object',
        required: ['name', 'age'],
        properties: {
            name: { type: 'string', description: 'User name' },
            age: { type: 'number', description: 'User age' },
            email: { type: 'string', description: 'User email address' }
        }
    };
    const compressed = compressToolSchema(schema);
    assert.ok(compressed.length < JSON.stringify(schema).length);
    assert.ok(compressed.includes('type: object'));
});

// Test 11: Tool result compression
test('Tool result compression', () => {
    const result = { success: true, data: testData.arrayOfObjects };
    const compressed = compressToolResult(result);
    assert.ok(compressed.length < JSON.stringify(result).length);
});

// Test 12: Large dataset
test('Large dataset encoding', () => {
    const largeData = Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `User${i}`,
        email: `user${i}@example.com`,
        active: i % 2 === 0
    }));
    const encoded = TOONEncoder.encode(largeData);
    const jsonSize = JSON.stringify(largeData).length;
    const toonSize = encoded.length;
    assert.ok(toonSize < jsonSize);
    console.log(`   Large dataset: JSON=${jsonSize} bytes, TOON=${toonSize} bytes, Savings=${((1 - toonSize / jsonSize) * 100).toFixed(1)}%`);
});

console.log(`\nTest Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
