import { TOONEncoder as TOON } from './toon-encoder.js';

// Scenario 2: Kubernetes Cluster Audit (Simulated)
// We create a large, repetitive JSON structure similar to a K8s pod list
const generateK8sData = (podCount: number) => {
    const pods = [];
    for (let i = 0; i < podCount; i++) {
        pods.push({
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
                name: `pod-${i}`,
                namespace: "default",
                uid: `uid-${i}`,
                resourceVersion: "123456",
                creationTimestamp: "2023-10-26T12:00:00Z",
                labels: {
                    app: "my-app",
                    tier: "frontend",
                    version: "v1.2.3"
                },
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9090"
                }
            },
            spec: {
                containers: [
                    {
                        name: "nginx",
                        image: "nginx:1.21.6",
                        ports: [{ containerPort: 80, protocol: "TCP" }],
                        resources: {
                            requests: { cpu: "100m", memory: "128Mi" },
                            limits: { cpu: "500m", memory: "512Mi" }
                        },
                        volumeMounts: [
                            { name: "config", mountPath: "/etc/nginx/conf.d" },
                            { name: "data", mountPath: "/usr/share/nginx/html" }
                        ]
                    }
                ],
                volumes: [
                    { name: "config", configMap: { name: "nginx-conf" } },
                    { name: "data", emptyDir: {} }
                ],
                restartPolicy: "Always",
                dnsPolicy: "ClusterFirst",
                serviceAccountName: "default"
            },
            status: {
                phase: "Running",
                conditions: [
                    { type: "Initialized", status: "True" },
                    { type: "Ready", status: "True" },
                    { type: "ContainersReady", status: "True" },
                    { type: "PodScheduled", status: "True" }
                ],
                hostIP: "10.0.0.1",
                podIP: `10.244.0.${i}`,
                startTime: "2023-10-26T12:00:05Z"
            }
        });
    }
    return {
        apiVersion: "v1",
        kind: "List",
        items: pods
    };
};

async function runBenchmark() {
    console.log("Running TOON Compression Benchmark...\n");

    const data = generateK8sData(50);
    const minifiedJson = JSON.stringify(data);
    const prettyJson = JSON.stringify(data, null, 2);

    const minifiedSize = minifiedJson.length;
    const prettySize = prettyJson.length;

    const start = performance.now();
    const toonString = TOON.encode(data);
    const end = performance.now();
    const compressedSize = toonString.length;

    const savingsMinified = ((minifiedSize - compressedSize) / minifiedSize) * 100;
    const savingsPretty = ((prettySize - compressedSize) / prettySize) * 100;

    console.log(`Scenario: Kubernetes Cluster Audit (50 Pods)`);
    console.log(`------------------------------------------`);
    console.log(`Original JSON (Minified): ${minifiedSize} chars`);
    console.log(`Original JSON (Pretty):   ${prettySize} chars`);
    console.log(`TOON Encoded Size:        ${compressedSize} chars`);
    console.log(`Savings (vs Minified):    ${savingsMinified.toFixed(2)}%`);
    console.log(`Savings (vs Pretty):      ${savingsPretty.toFixed(2)}%`);
    console.log(`Time:                     ${(end - start).toFixed(2)}ms`);

    if (savingsMinified > 90 || savingsPretty > 90) {
        console.log("\n✅ SUCCESS: >90% savings achieved (Validates README claim)");
        if (savingsPretty > 90 && savingsMinified < 90) {
            console.log("(Note: Claim appears to be based on comparison with Pretty-Printed JSON)");
        }
    } else {
        console.log("\n❌ FAILURE: <90% savings (Claim not validated)");
        process.exit(1);
    }
}

runBenchmark();
