/** Print a site's current preview URL: bun scripts/nova/preview-url.ts <baseUrl> <apiKeyFile> <agentId> */
import { readFileSync } from 'node:fs';
import { VibeClient } from '../../sdk/src/index';

const [baseUrl, keyFile, agentId] = process.argv.slice(2);
const apiKey = JSON.parse(readFileSync(keyFile, 'utf8')).data.key as string;
const session = await new VibeClient({ baseUrl, apiKey }).connect(agentId);
await session.connect();
session.deployPreview();
const preview = await session.wait.previewDeployed({ timeoutMs: 120_000 });
console.log(preview.previewURL);
console.log(JSON.stringify(session.files.listPaths()));
session.close();
