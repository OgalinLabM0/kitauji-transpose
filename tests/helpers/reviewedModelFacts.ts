import assert from 'node:assert/strict';
import type { ProjectStore } from '../../src/core/db';
import { fakeAi } from '../helpers';
import { initialCandidateCurrent, initialCandidates, initialHash, quarantineInitialFields, type InitialFieldCandidate } from '../../src/core/db/initialFieldTrust';
import { initialOwnershipInput, initialSupportInput, type InitialOwnership } from '../../src/core/validation/initialFieldEvidence';
import { reviewInitialFields } from '../../src/core/workflow/initialFieldAttribution';
import { resolveCharacterKnowledge } from '../../src/core/workflow/automaticFieldDecisions';
import type { CharacterField } from '../../src/core/db/characterHistory';
import { containsVisibleQuote } from '../../src/core/validation/nameEvidence';

type Quote = { paragraph_id: string; quote: string };
export interface ReviewedModelField {
  characterId: string; field: CharacterField; value: unknown;
  evidence: Quote[]; attribution: Quote[]; scope: 'durable' | 'local';
}

/** Only explicit, source-grounded synthetic baselines. Never a default fakeAi response. */
export async function reviewModelFields(store: ProjectStore, volumeId: string, expected: ReviewedModelField[]): Promise<void> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const userFacts = JSON.stringify(store.db.all("SELECT * FROM character_field_history WHERE origin='user'"));
  quarantineInitialFields(store, seriesId);
  const pending = initialCandidates(store.db, seriesId).filter(c => c.status === 'pending' && initialCandidateCurrent(store.db, c));
  assert.equal(pending.length, expected.length, 'List every baseline explicitly; never silently confirm extra candidates');
  const planned = new Map<string, ReviewedModelField>();
  for (const c of pending) {
    const matches = expected.filter(e => e.characterId === c.characterId && e.field === c.field &&
      JSON.stringify(e.value) === JSON.stringify(c.value) &&
      JSON.stringify([...new Set(e.evidence.map(q => q.paragraph_id))].sort()) === JSON.stringify([...c.evidenceIds].sort()));
    assert.equal(matches.length, 1, 'Each candidate needs one explicit field/value/evidence expectation');
    const e = matches[0]!;
    assert.ok(c.nameQuote, 'A named original is required, not a scene-analysis identity');
    assert.ok(e.attribution.length && e.evidence.length);
    for (const q of [...e.evidence, ...e.attribution]) assert.ok(containsVisibleQuote(store.projects.getParagraph(q.paragraph_id)?.sourceText ?? '', q.quote), 'Fixture citation must match the production visible-source boundary');
    planned.set(c.id, e);
  }
  const groups = new Map<string, InitialFieldCandidate[]>();
  for (const c of pending) {
    const key = initialHash([c.characterId, c.sourceProof, c.nameProof]);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const responses = new Map<string, unknown>();
  for (const group of groups.values()) for (let start = 0; start < group.length; start += 5) {
    const candidates = group.slice(start, start + 5);
    const ownershipInput = initialOwnershipInput(candidates);
    const sourceIds = [...new Map(candidates.flatMap(c => c.sources).map(s => [s.id, s])).values()].sort((a, b) => a.at - b.at).map(s => s.id);
    const short = (q: Quote) => ({ id: 'p' + (sourceIds.indexOf(q.paragraph_id) + 1), quote: q.quote });
    const ownership: InitialOwnership = { items: candidates.map((c, index) => ({ id: 'f' + (index + 1), owner: 'target',
      basis: planned.get(c.id)!.attribution.map(short), reason: '测试基线原文明示本人发言或属性；未使用人物档案推断。' })) };
    responses.set(JSON.stringify(ownershipInput), ownership);
    responses.set(JSON.stringify(initialSupportInput(candidates, ownership)), { items: candidates.map((c, index) => ({ id: 'f' + (index + 1),
      decision: planned.get(c.id)!.scope === 'local' ? 'local' : 'adopt', basis: planned.get(c.id)!.evidence.map(short),
      reason: '只核对本测试显式列出的值；局部观察保持局部范围。' })) });
  }
  const seen = new Set<string>();
  await reviewInitialFields(store, fakeAi(store, request => {
    assert.ok(responses.has(request.user), 'Unexpected review request cannot receive blanket approval');
    seen.add(request.user); return responses.get(request.user);
  }), volumeId);
  assert.equal(seen.size, responses.size, 'Both real parsers and call-receipt paths must execute');
  for (const c of initialCandidates(store.db, seriesId).filter(c => planned.has(c.id))) {
    const assessment = c.review?.assessment as { attribution?: string; support?: string; scope?: string } | undefined;
    assert.equal(assessment?.attribution, 'target'); assert.equal(assessment?.support, 'full');
    assert.equal(assessment?.scope, planned.get(c.id)!.scope);
    assert.ok(initialCandidateCurrent(store.db, c));
  }
  assert.equal(JSON.stringify(store.db.all("SELECT * FROM character_field_history WHERE origin='user'")), userFacts, 'Independent model review must not create human facts');
}

/** Explicit first-person change baseline through the production stage parser and receipt. */
export async function reviewModelFirstPersonStage(store: ProjectStore, volumeId: string, expected: {
  characterId: string; before: string; proposed: string; citations: Quote[];
}): Promise<void> {
  const seriesId = store.projects.getVolumeSeriesId(volumeId);
  const pending = store.translations.listQueue(seriesId).filter(q => q.payload.subtype === 'character-field');
  assert.equal(pending.length, 1);
  const conflict = pending[0]!.payload;
  assert.equal(conflict.characterId, expected.characterId); assert.equal(conflict.field, 'first_person_type');
  assert.equal(conflict.before, expected.before); assert.equal(conflict.proposed, expected.proposed);
  const result = await resolveCharacterKnowledge(store, fakeAi(store, request => {
    const input = JSON.parse(request.user);
    assert.equal(input.character, store.knowledge.getCharacter(expected.characterId)!.canonical_name_jp);
    assert.equal(input.field, 'first_person_type'); assert.equal(input.before, expected.before); assert.equal(input.proposed, expected.proposed);
    const sources = input.sources as { id: string; text: string }[];
    assert.ok(sources?.length);
    for (const q of expected.citations) assert.ok(sources.some(s => s.id === q.paragraph_id && containsVisibleQuote(s.text,q.quote)));
    return { reviewed_ids: sources.map(s => s.id), verdict: 'supported-change', attribution: 'supported',
      reason: '明示本人从此前自称改用另一自称，原句与基线对应。', citations: expected.citations };
  }), volumeId);
  assert.equal(result.adopted, 1);
  assert.equal(store.knowledge.getCharacter(expected.characterId)!.locked_by_user, 0);
  assert.equal(store.db.get<{ origin: string }>("SELECT origin FROM character_field_history WHERE character_id=? AND field='first_person_type' ORDER BY valid_from_para DESC LIMIT 1", [expected.characterId])!.origin, 'model');
}

export const fixtureQuote = (store: ProjectStore, paragraph_id: string): Quote => ({ paragraph_id, quote: store.projects.getParagraph(paragraph_id)!.sourceText });
