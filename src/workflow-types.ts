export interface WorkflowDefinition {
    name: string;
    description: string;
    parameters: {
        [key: string]: {
            type: 'string' | 'number' | 'boolean' | 'array' | 'object';
            description?: string;
            required?: boolean;
            default?: any;
        };
    };
    execute: (params: any, context: WorkflowContext) => Promise<any>;
}

export interface WorkflowContext {
    servers: Record<string, any>;  // Access to lazy-loaded MCP servers
    encode: (data: any) => string; // TOON encoder
}
