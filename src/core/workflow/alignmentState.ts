export const ALIGNMENT_PENDING_MESSAGE='存在未确定的原译对应信息，需要查看后决定，不能自动采纳';
export function isAlignmentPendingState(f:{workstation_id:string;finding_type:string;description:string;evidence_jp:string|null;evidence_zh:string|null}):boolean {
 return f.workstation_id==='program-check'&&f.finding_type==='REVIEW:ALIGNMENT_UNCERTAIN'&&f.description===ALIGNMENT_PENDING_MESSAGE&&!f.evidence_jp&&!f.evidence_zh;
}
