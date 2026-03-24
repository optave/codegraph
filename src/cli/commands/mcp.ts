import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'mcp',
  description: 'Start MCP (Model Context Protocol) server for AI assistant integration',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--multi-repo', 'Enable access to all registered repositories'],
    ['--repos <names>', 'Comma-separated list of allowed repo names (restricts access)'],
  ],
  async execute(_args, opts) {
    const { startMCPServer } = await import('../../mcp/index.js');
    const mcpOpts: any = {};
    mcpOpts.multiRepo = opts.multiRepo || !!opts.repos;
    if (opts.repos) {
      mcpOpts.allowedRepos = (opts.repos as string).split(',').map((s) => s.trim());
    }
    await startMCPServer(opts.db as string | undefined, mcpOpts);
  },
};
