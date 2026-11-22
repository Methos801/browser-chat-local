export interface ContextInfo {
  usedTokens: number; limitTokens: number; reservedTokens: number;
  percent: number; approximate: true; compacted: boolean; removedMessages: number;
  summary?: string;
}
export interface Skill {
  id: string; name: string; description: string; instructions: string;
  enabled: boolean; builtIn: boolean; source: string; hint?: string;
  tools: string[]; resources?: string[];
}
export interface SkillDraft { name: string; description: string; instructions: string; source: string; hint?: string; resources?: Record<string,string>; }
export interface McpServerInput {
  name: string; transport: 'http' | 'sse' | 'stdio'; url?: string;
  command?: string; args?: string[]; env?: Record<string,string>;
  enabled?: boolean; timeout?: number; token?: string; oauth?: boolean; provider?: string;
}
export interface McpServerView {
  name: string; transport: 'http' | 'sse' | 'stdio'; url?: string;
  command?: string; args: string[]; enabled: boolean; timeout: number;
  provider?: string; needsSetup?: boolean;
  status: 'needs-setup' | 'connected' | 'disabled' | 'unavailable' | 'saved' | 'sign-in' | 'connecting';
  message: string; tools: {name:string;description:string}[];
  secretNames: string[]; hasToken: boolean; oauth: boolean;
}
export interface CompactResult { summary: string; removedMessages: number; mode: 'model' | 'extractive'; }
