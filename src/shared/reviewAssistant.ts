export interface ReviewAssistantReply {
  answer: string;
  evidence: { id: string; source: string; zh: string }[];
  english: string | null;
  gloss: string | null;
}
export interface ReviewAssistantConversation {
  turns: { question: string; reply: ReviewAssistantReply }[];
}
