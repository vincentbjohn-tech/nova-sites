/** Publish a site and time it: bun scripts/nova/publish.ts <baseUrl> <apiKeyFile> <agentId> */
import { readFileSync } from 'node:fs';
import { VibeClient } from '../../sdk/src/index';

const [baseUrl, keyFile, agentId] = process.argv.slice(2);
const apiKey = JSON.parse(readFileSync(keyFile, 'utf8')).data.key as string;
const session = await new VibeClient({ baseUrl, apiKey }).connect(agentId);
await session.connect();
const t0 = Date.now();
session.deployCloudflare();
const done = await session.wait.cloudflareDeployed({ timeoutMs: 180_000 });
console.log(JSON.stringify({ seconds: ((Date.now() - t0) / 1000).toFixed(1), url: done.deploymentUrl }));
session.close();
