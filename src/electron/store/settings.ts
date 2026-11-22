import type { AppDb } from "./db";
import type { AppSettings, Fact } from "../ipc";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS } from "../services/modelBudget";
export const DEFAULT_SETTINGS: AppSettings = { automatic: true, contextTokens: DEFAULT_CONTEXT_TOKENS, maxOutputTokens: DEFAULT_OUTPUT_TOKENS, maxToolIterations: 6, timeoutMs: 180000, memoryRecall: true };
export class SettingsStore {
  constructor(private db: AppDb) {}
  get(): AppSettings {
    const row = this.db.get<{config_json: string}>("SELECT config_json FROM skills WHERE name = 'settings'");
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.config_json) : {}) };
  }
  save(value: AppSettings): void {
    if (typeof value.automatic !== "boolean" || typeof value.memoryRecall !== "boolean") throw new Error("Invalid settings mode");
    for (const [key, min, max] of [["contextTokens",2048,131072],["maxOutputTokens",64,32768],["maxToolIterations",0,20],["timeoutMs",1000,600000]] as const) {
      if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
    }
    if (value.maxOutputTokens > value.contextTokens / 2) throw new Error("Output budget must not exceed half the context window");
    this.db.run("INSERT OR REPLACE INTO skills (name, enabled, config_json) VALUES ('settings',1,?)", [JSON.stringify(value)]);
  }
  facts(): Fact[] { return this.db.all<Fact>("SELECT * FROM facts ORDER BY id DESC"); }
  remember(text: string, source = "user"): void {
    if (!text.trim() || text.length > 4000) throw new Error("Memory must contain 1–4000 characters");
    this.db.run("INSERT INTO facts (text,source,created_at) VALUES (?,?,?)", [text.trim(),source,new Date().toISOString()]);
  }
  forget(id: number): void { this.db.run("DELETE FROM facts WHERE id = ?", [id]); }
}
