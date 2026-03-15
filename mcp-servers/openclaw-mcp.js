#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';

const server = new Server(
  { name: 'openclaw-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: 'openclaw_status',
    description: 'Check OpenClaw gateway and channel status',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'openclaw_message',
    description: 'Send a message via OpenClaw',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', default: 'whatsapp' },
        target: { type: 'string', description: 'Phone number or channel ID' },
        message: { type: 'string', description: 'Message to send' }
      },
      required: ['message', 'target']
    }
  },
  {
    name: 'openclaw_screenshot',
    description: 'Take a screenshot and optionally send via WhatsApp',
    inputSchema: {
      type: 'object',
      properties: {
        send_to_whatsapp: { type: 'boolean', default: false },
        target: { type: 'string', default: '+918076536278' }
      }
    }
  },
  {
    name: 'openclaw_gateway',
    description: 'Control OpenClaw gateway (start/stop/restart)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'] }
      },
      required: ['action']
    }
  },
  {
    name: 'openclaw_browser',
    description: 'Control OpenClaw browser (screenshot, navigate, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'start', 'stop', 'status'] },
        url: { type: 'string' }
      },
      required: ['action']
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;

    switch (name) {
      case 'openclaw_status':
        result = execSync('openclaw channels status', { encoding: 'utf-8' });
        break;

      case 'openclaw_message':
        result = execSync(
          `openclaw message send --channel ${args.channel || 'whatsapp'} --target "${args.target}" --message "${args.message}"`,
          { encoding: 'utf-8' }
        );
        break;

      case 'openclaw_screenshot':
        // Take screenshot
        execSync('screencapture -x /tmp/mcp_screenshot.png', { encoding: 'utf-8' });
        execSync('cp /tmp/mcp_screenshot.png ~/.openclaw/media/', { encoding: 'utf-8' });

        if (args.send_to_whatsapp) {
          result = execSync(
            `openclaw message send --channel whatsapp --target "${args.target || '+918076536278'}" --media "~/.openclaw/media/mcp_screenshot.png"`,
            { encoding: 'utf-8' }
          );
        } else {
          result = 'Screenshot saved to ~/.openclaw/media/mcp_screenshot.png';
        }
        break;

      case 'openclaw_gateway':
        result = execSync(`openclaw gateway ${args.action}`, { encoding: 'utf-8' });
        break;

      case 'openclaw_browser':
        if (args.action === 'screenshot') {
          result = execSync('openclaw browser screenshot', { encoding: 'utf-8' });
        } else if (args.action === 'start') {
          result = execSync('openclaw browser start', { encoding: 'utf-8' });
        } else if (args.action === 'stop') {
          result = execSync('openclaw browser stop', { encoding: 'utf-8' });
        } else if (args.action === 'status') {
          result = execSync('openclaw browser status', { encoding: 'utf-8' });
        }
        break;

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    return { content: [{ type: 'text', text: result || 'Success' }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
