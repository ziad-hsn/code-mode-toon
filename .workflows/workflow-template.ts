import { WorkflowDefinition } from '../src/workflow-types.js';

export const workflow: WorkflowDefinition = {
    name: 'workflow-template',
    description: 'A template for creating new workflows',

    parameters: {
        exampleParam: {
            type: 'string',
            description: 'An example parameter',
            required: true
        }
    },

    async execute(params, context) {
        // Access MCP servers via context.servers
        // e.g. await context.servers['server-name'].tool_name({ ... })

        return {
            message: `Hello, ${params.exampleParam}!`,
            timestamp: new Date().toISOString()
        };
    }
};
