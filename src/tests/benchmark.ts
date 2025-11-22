import { TOONEncoder } from '../toon-encoder.js';

// Benchmark configuration
const ITERATIONS = 1000;

// Test datasets
const datasets = {
    small: {
        name: 'Small Object',
        data: { id: 1, name: 'Alice', email: 'alice@example.com', active: true }
    },
    medium: {
        name: 'Medium Array',
        data: Array.from({ length: 10 }, (_, i) => ({
            id: i,
            name: `User${i}`,
            email: `user${i}@example.com`,
            role: i % 2 === 0 ? 'admin' : 'user',
            active: i % 3 === 0
        }))
    },
    large: {
        name: 'Large Array',
        data: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `User${i}`,
            email: `user${i}@example.com`,
            department: `Dept${i % 5}`,
            role: i % 2 === 0 ? 'admin' : 'user',
            active: i % 3 === 0,
            metadata: { created: '2024-01-01', updated: '2024-01-02' }
        }))
    },
    toolSchema: {
        name: 'MCP Tool Schema',
        data: {
            type: 'object',
            required: ['serverName', 'toolName', 'arguments'],
            properties: {
                serverName: {
                    type: 'string',
                    description: 'Name of the MCP server to call'
                },
                toolName: {
                    type: 'string',
                    description: 'Name of the tool to invoke'
                },
                arguments: {
                    type: 'object',
                    description: 'Arguments to pass to the tool'
                },
                timeout: {
                    type: 'number',
                    description: 'Optional timeout in milliseconds'
                }
            }
        }
    }
};

function benchmark(name: string, fn: () => void, iterations: number): number {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        fn();
    }
    const end = performance.now();
    return end - start;
}

function measureSize(data: any): { json: number; toon: number; savings: number } {
    const jsonStr = JSON.stringify(data);
    const toonStr = TOONEncoder.encode(data);

    const jsonSize = Buffer.byteLength(jsonStr, 'utf8');
    const toonSize = Buffer.byteLength(toonStr, 'utf8');
    const savings = ((1 - toonSize / jsonSize) * 100);

    return { json: jsonSize, toon: toonSize, savings };
}

console.log('TOON Encoder Benchmarks\n');
console.log('='.repeat(80));

// Size comparison
console.log('\nSize Comparison (bytes)\n');
console.log('Dataset'.padEnd(25) + 'JSON'.padEnd(12) + 'TOON'.padEnd(12) + 'Savings');
console.log('-'.repeat(80));

for (const [key, dataset] of Object.entries(datasets)) {
    const { json, toon, savings } = measureSize(dataset.data);
    console.log(
        dataset.name.padEnd(25) +
        json.toString().padEnd(12) +
        toon.toString().padEnd(12) +
        `${savings.toFixed(1)}%`
    );
}

// Performance benchmarks
console.log('\nPerformance Benchmarks (ms for ' + ITERATIONS + ' iterations)\n');
console.log('Dataset'.padEnd(25) + 'JSON.stringify'.padEnd(18) + 'TOON.encode'.padEnd(18) + 'Ratio');
console.log('-'.repeat(80));

for (const [key, dataset] of Object.entries(datasets)) {
    const jsonTime = benchmark(
        'JSON.stringify',
        () => JSON.stringify(dataset.data),
        ITERATIONS
    );

    const toonTime = benchmark(
        'TOON.encode',
        () => TOONEncoder.encode(dataset.data),
        ITERATIONS
    );

    const ratio = (toonTime / jsonTime).toFixed(2);

    console.log(
        dataset.name.padEnd(25) +
        jsonTime.toFixed(2).padEnd(18) +
        toonTime.toFixed(2).padEnd(18) +
        `${ratio}x`
    );
}

// Decoding benchmarks
console.log('\nDecoding Benchmarks (ms for ' + ITERATIONS + ' iterations)\n');
console.log('Dataset'.padEnd(25) + 'JSON.parse'.padEnd(18) + 'TOON.decode'.padEnd(18) + 'Ratio');
console.log('-'.repeat(80));

for (const [key, dataset] of Object.entries(datasets)) {
    const jsonStr = JSON.stringify(dataset.data);
    const toonStr = TOONEncoder.encode(dataset.data);

    const jsonTime = benchmark(
        'JSON.parse',
        () => JSON.parse(jsonStr),
        ITERATIONS
    );

    const toonTime = benchmark(
        'TOON.decode',
        () => TOONEncoder.decode(toonStr),
        ITERATIONS
    );

    const ratio = (toonTime / jsonTime).toFixed(2);

    console.log(
        dataset.name.padEnd(25) +
        jsonTime.toFixed(2).padEnd(18) +
        toonTime.toFixed(2).padEnd(18) +
        `${ratio}x`
    );
}

// Token estimation (rough approximation: 1 token ≈ 4 characters)
console.log('\nEstimated Token Savings\n');
console.log('Dataset'.padEnd(25) + 'JSON Tokens'.padEnd(15) + 'TOON Tokens'.padEnd(15) + 'Saved');
console.log('-'.repeat(80));

for (const [key, dataset] of Object.entries(datasets)) {
    const { json, toon, savings } = measureSize(dataset.data);
    const jsonTokens = Math.ceil(json / 4);
    const toonTokens = Math.ceil(toon / 4);
    const savedTokens = jsonTokens - toonTokens;

    console.log(
        dataset.name.padEnd(25) +
        `~${jsonTokens}`.padEnd(15) +
        `~${toonTokens}`.padEnd(15) +
        `~${savedTokens} (${savings.toFixed(1)}%)`
    );
}

console.log('\n' + '='.repeat(80));
console.log('\nBenchmark complete!\n');
