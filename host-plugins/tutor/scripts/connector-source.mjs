import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const home = join(homedir(), '.local', 'share', 'tutor');
  const instancePattern = '^[a-f0-9]{24}$';
  const routingProperty = { type: 'string', pattern: instancePattern, description: 'Route this call to this paired local Tutor instance, without changing the default vault.' };
  let selected = process.env.TUTOR_INSTANCE_ID;
  const connections = new Map(), liveConnections = new Set();
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const validateInstanceId = id => {
    if (id !== undefined && (typeof id !== 'string' || !new RegExp(instancePattern).test(id))) throw new Error('Invalid instanceId');
    return id;
  };

  async function instances() {
    let names = [];
    try { names = await readdir(join(home, 'instances')); } catch { return []; }
    const result = [];
    for (const name of names.filter(n => /^[a-f0-9]{24}\.json$/.test(n))) {
      try {
        const entry = await read(join(home, 'instances', name));
        if (entry.id + '.json' !== name || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || !Number.isInteger(entry.pid)) continue;
        process.kill(entry.pid, 0);
        result.push(entry);
      } catch {}
    }
    return result;
  }

  // Capture the default before discovery yields: selection changes must never reroute an in-flight request.
  async function instance(id = selected) {
    validateInstanceId(id);
    const list = await instances();
    const entry = list.find(i => i.id === id) ?? (id === undefined && list.length === 1 ? list[0] : undefined);
    if (!entry) throw new Error(list.length ? 'Choose an instanceId with tutor_connect or on this tool call.' : 'Tutor unavailable: open Obsidian and enable Tutor MCP.');
    return entry;
  }

  function closeConnection(connection, force = false) {
    if (connection.closing || (!force && connection.active)) return;
    connection.closing = true;
    if (connections.get(connection.id) === connection) connections.delete(connection.id);
    void connection.client.then(client => client.close()).catch(() => {}).finally(() => liveConnections.delete(connection));
  }

  function retire(connection) {
    connection.retired = true;
    if (connections.get(connection.id) === connection) connections.delete(connection.id);
    closeConnection(connection);
  }

  async function withRemote(entry, operation) {
    const record = await read(join(home, 'clients', `codex-${entry.id}.json`)).catch(() => null);
    if (typeof record?.token !== 'string' || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('Tutor is not paired. Call tutor_connect and select the permitted scope in Obsidian.');
    let connection = connections.get(entry.id);
    if (connection && (connection.port !== entry.port || connection.token !== record.token)) { retire(connection); connection = undefined; }
    if (!connection) {
      // Both endpoint and credentials belong to this immutable request binding.
      const client = new Client({ name: 'tutor-codex', version: '0.5.0' });
      const ready = (async () => {
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${entry.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${record.token}` } } }));
          return client;
        } catch (error) { await client.close().catch(() => {}); throw error; }
      })();
      connection = { id: entry.id, port: entry.port, token: record.token, client: ready, active: 0, retired: false, closing: false };
      connections.set(entry.id, connection);
      liveConnections.add(connection);
    }
    connection.active++;
    try { return await operation(await connection.client); }
    catch (error) { retire(connection); throw error; }
    finally { connection.active--; if (connection.retired) closeConnection(connection); }
  }

  const tools = [
    { name: 'tutor_instances', description: 'Find running local Obsidian Tutor vaults. This contains no credentials.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'tutor_connect', description: 'Request pairing with one local vault and set the default. Choose the authorized documents, canvases and selected objects in the Obsidian dialog. Existing pairing can be reused; re-pair only to change scope. Other calls may use instanceId to target a vault without changing this default.', inputSchema: { type: 'object', properties: { instanceId: routingProperty, repair: { type: 'boolean' } }, additionalProperties: false } },
    { name: 'tutor_diagnose', description: 'Check one local service and pairing without printing credentials or changing the default vault.', inputSchema: { type: 'object', properties: { instanceId: routingProperty }, additionalProperties: false } }
  ];
  const localNames = new Set(tools.map(tool => tool.name));
  const server = new Server({ name: 'tutor-connector', version: '0.5.0' }, { capabilities: { tools: { listChanged: true } } });

  async function forwardedTools() {
    const preferred = selected;
    const entries = (await instances()).sort((a, b) => a.id === preferred ? -1 : b.id === preferred ? 1 : a.id.localeCompare(b.id));
    // Discovery reuses existing grants only. It never opens pairing or broadens a vault's scope.
    const lists = await Promise.allSettled(entries.map(entry => withRemote(entry, client => client.listTools())));
    const grouped = new Map();
    for (let index = 0; index < lists.length; index++) {
      const list = lists[index];
      if (list.status !== 'fulfilled') continue;
      for (const tool of list.value.tools) {
        if (!tool.name.startsWith('tutor_') || localNames.has(tool.name)) continue;
        const variants = grouped.get(tool.name) ?? [];
        variants.push({ tool, instanceId: entries[index].id });
        grouped.set(tool.name, variants);
      }
    }
    return [...grouped.values()].map(variants => {
      const tool = { ...variants[0].tool };
      const schemas = [...new Map(variants.map(({ tool }) => {
        const schema = { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, instanceId: routingProperty } };
        return [JSON.stringify(schema), schema];
      })).values()];
      tool.inputSchema = schemas.length === 1 ? schemas[0] : { type: 'object', properties: { instanceId: routingProperty }, anyOf: schemas };
      tool.description = `${tool.description ?? tool.name}\nPaired local instances: ${variants.map(variant => variant.instanceId).join(', ')}. Use optional instanceId to route this call; otherwise the tutor_connect default is used.`;
      if (variants.some(variant => JSON.stringify(variant.tool.outputSchema) !== JSON.stringify(tool.outputSchema))) delete tool.outputSchema;
      if (variants.length > 1) {
        tool.annotations = { ...tool.annotations,
          readOnlyHint: variants.every(variant => variant.tool.annotations?.readOnlyHint === true),
          destructiveHint: variants.some(variant => variant.tool.annotations?.destructiveHint !== false),
          idempotentHint: variants.every(variant => variant.tool.annotations?.idempotentHint === true),
          openWorldHint: variants.some(variant => variant.tool.annotations?.openWorldHint !== false)
        };
      }
      return tool;
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools, ...await forwardedTools()] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name, args = request.params.arguments ?? {};
    const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
    try {
      if (name === 'tutor_instances') return result({ instances: await instances() });
      validateInstanceId(args.instanceId);
      const targetId = validateInstanceId(args.instanceId === undefined ? selected : args.instanceId);
      if (name === 'tutor_connect') {
        const entry = await instance(targetId);
        if (!args.repair) {
          try {
            await withRemote(entry, async () => {});
            selected = entry.id;
            await server.sendToolListChanged();
            return result({ connected: true, instanceId: entry.id });
          } catch {}
        }
        const response = await fetch(`http://127.0.0.1:${entry.port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Codex Tutor plugin' }), signal: AbortSignal.any([extra.signal, AbortSignal.timeout(125000)]) });
        if (!response.ok) throw new Error('Pairing declined, busy, or unavailable. Check Obsidian.');
        const data = await response.json();
        if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) throw new Error('Invalid pairing response');
        const dir = join(home, 'clients');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `codex-${entry.id}.json`);
        await writeFile(path + '.tmp', JSON.stringify({ token: data.token, clientId: data.clientId }), { mode: 0o600 });
        await rename(path + '.tmp', path);
        await withRemote(entry, async () => {});
        selected = entry.id;
        await server.sendToolListChanged();
        return result({ connected: true, instanceId: entry.id });
      }
      const entry = await instance(targetId);
      if (name === 'tutor_diagnose') {
        await withRemote(entry, async () => {});
        return result({ available: true, instanceId: entry.id, name: entry.name });
      }
      if (!name.startsWith('tutor_')) throw new Error('Unknown Tutor tool');
      const { instanceId: _route, ...remoteArgs } = args;
      return await withRemote(entry, client => client.callTool({ ...request.params, arguments: remoteArgs }, undefined, { signal: extra.signal, timeout: 120000 }));
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: String(error.message ?? 'Tutor connection failed').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') }] };
    }
  });
  await server.connect(new StdioServerTransport());
  process.on('SIGTERM', () => {
    for (const connection of liveConnections) { retire(connection); closeConnection(connection, true); }
    void server.close();
  });
}

main().catch(() => { process.stderr.write('Tutor connector failed to start. Use Node.js 22 or later.\n'); process.exitCode = 1; });
