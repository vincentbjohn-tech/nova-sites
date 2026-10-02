/** One request to Nova on a site, timed, printing her final reply: bun scripts/nova/turn.ts <baseUrl> <token> <siteId> "<request>" */
import { VibeClient } from '../../sdk/src/index';

const [baseUrl, token, siteId, text] = process.argv.slice(2);
const session = await new VibeClient({ baseUrl, token }).connect(siteId);
await session.connect();
const finals: string[] = [];
const tools: string[] = [];
session.on('ws:message', (m: { type: string; message?: string; isStreaming?: boolean; tool?: { name: string; status: string } }) => {
	if (m.type === 'conversation_response' && m.tool?.status === 'start') tools.push(m.tool.name);
	if (m.type === 'conversation_response' && !m.tool && m.isStreaming === false && m.message) finals.push(m.message);
});
const t0 = Date.now();
session.followUp(text);
await session.wait.generationStarted({ timeoutMs: 60_000 }).catch(() => undefined);
await session.wait.generationComplete({ timeoutMs: 600_000 });
console.log(JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), steps: tools.length, reply: finals.at(-1) ?? '' }));
session.close();
process.exit(0);
