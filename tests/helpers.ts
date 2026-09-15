import {SOURCE_STYLE_PROMPT} from '../src/core/validation/sourceStyleEvidence';
import { ProjectStore } from '../src/core/db';
import { importTxt } from '../src/core/txt/txtImport';
import { AiClient, type ChatRequest, type ChatResponse, type ProviderConfig } from '../src/core/ai';

export function fixture(source = '雨が降る。') {
  const store = new ProjectStore(':memory:');
  const imported = importTxt(store, 'test.txt', new TextEncoder().encode(source));
  const ids = store.projects.listParagraphIdsByVolume(imported.volumeId);
  return { store, ...imported, ids, paragraphId: ids[0]! };
}
export const provider: ProviderConfig = { baseUrl: 'http://invalid.test', protocol: 'chat-completions', model: 'deepseek-flash', apiKey: '', authScheme: 'none', temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 100, thinkingMode: 'disabled' };
export function fakeAi(store: ProjectStore, respond: (request: ChatRequest, config: ProviderConfig) => unknown | Promise<unknown>) {
  return new AiClient(store, { primary: provider, concurrency: 2, networkRetries: 0 }, async (config, request): Promise<ChatResponse> => ({ text: JSON.stringify(await respond(request, config)), finishReason: 'stop', truncated: false, inputTokens: 10, outputTokens: 10 }));
}
export function requestedItems(request: ChatRequest): { id: string; source: string; translation?: string }[] {
  const start = request.user.lastIndexOf('{"items":');
  if (start < 0) throw new Error('Missing request items');
  return JSON.parse(request.user.slice(start).split('\n')[0]!).items;
}

export function alignmentResponse(request: ChatRequest): unknown | undefined {
  if (!request.system.includes('只核对 source')) return undefined;
  const input = JSON.parse(request.user);
  return { source_coverage: [{ ord: 1, segment: input.source, rendered_as: input.translation, status: 'covered' }] };
}

/** Explicit passing naturalness fixture for tests exercising other workflow contracts. */
export function naturalnessResponse(request: ChatRequest): unknown | undefined {
  if (!request.system.includes('你只检查当前中文译稿')) return undefined;
  return { id: JSON.parse(request.user).id, decision: 'keep', issues: [] };
}

/** Explicit passing fixture for tests focused on other repair contracts. */
export function repairResolutionResponse(request: ChatRequest): unknown | undefined {
  if (!request.system.includes('你只验收指定问题是否解决')) return undefined;
  const input = JSON.parse(request.user);
  return { items: input.issues.map((i: { id: string }) => ({ id: i.id, decision: 'resolved', source_quote: input.source, target_quote: input.after, reason: '模拟验收通过' })) };
}

/** Explicit negative source-style fixture: recovery tests still require edits. */
export function sourceStyleRevisionResponse(request:ChatRequest):unknown|undefined {
  if(request.system!==SOURCE_STYLE_PROMPT)return undefined;
  const input=JSON.parse(request.user);
  return {decision:'revise',source_quote:input.source,target_quote:input.translation,reason:'本测试的既有表达问题仍需修复',direction:'修复测试指定的中文表达问题'};
}

/** Explicit passing fixture for chapter reading and trajectory review. */
export function reviewResponse(request: ChatRequest): unknown | undefined {
  if (!request.system.includes('reviewed_ids')) return undefined;
  return { reviewed_ids: requestedItems(request).map(p => p.id), findings: [] };
}
