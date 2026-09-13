import type {AiClientConfig} from '../src/core/ai/client';
import {TRANSLATION_THINKING_POLICY} from '../src/core/ai/translationThinking';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderSettings } from '@shared/types';
import type { ProviderConfig } from '@core/ai';
import { TRANSLATION_PROFILE } from '@shared/translationProfile';
import { atomicSettingsWrite } from './atomicSettingsWrite';

type StoredProvider = Omit<ProviderSettings, 'hasApiKey' | 'pricingInput' | 'pricingOutput'>;
export interface SettingsEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const DEFAULTS: StoredProvider = {
  baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions', model: 'deepseek-flash', judgeModel: '',
  authScheme: 'bearer', temperature: 0.2, maxOutputTokens: 16384, concurrency: 3, timeoutMs: 180_000,
  thinkingMode: 'disabled', reasoningEffort: 'low', usePreprocessingModel: false,
  preprocessingModel: '', preprocessingThinkingMode: 'auto', preprocessingReasoningEffort: 'medium',
};
interface Persisted {
  provider: StoredProvider;
  ui: Record<string, unknown>;
  pricing: { input: number; output: number } | null;
  // Presence distinguishes an explicitly cleared key from a legacy key file.
  encryptedApiKey?: string | null;
  settingsFormat?: number;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function normalizedProvider(value: Record<string, unknown>): StoredProvider {
  const result = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS) as (keyof StoredProvider)[]) {
    if (value[name] === undefined) continue;
    if (typeof value[name] !== typeof DEFAULTS[name]) throw new Error('接口设置字段类型无效');
    Object.assign(result, { [name]: value[name] });
  }
  if (!['chat-completions', 'responses', 'anthropic-messages'].includes(result.protocol) ||
      !['bearer', 'x-api-key', 'none'].includes(result.authScheme) ||
      !Number.isFinite(result.temperature) || result.temperature < 0 || result.temperature > 2 ||
      ![result.concurrency, result.timeoutMs, result.maxOutputTokens].every(v => Number.isSafeInteger(v) && v > 0)) {
    throw new Error('接口设置值无效');
  }
  return { ...result, ...TRANSLATION_PROFILE };
}

/** Pure storage layer; Electron supplies the directory and OS encryption. */
export class SettingsStore {
  private readonly file: string;
  private readonly keyFile: string;
  private data: Persisted;
  private damagedSettings: Buffer | null = null;
  private notice = '';
  constructor(directory: string, private readonly encryption: SettingsEncryption,
    private readonly write: typeof atomicSettingsWrite = atomicSettingsWrite) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'settings.json');
    this.keyFile = join(directory, 'apikey.bin');
    this.data = { provider: { ...DEFAULTS, ...TRANSLATION_PROFILE }, ui: {}, pricing: null };
    if (!existsSync(this.file)) {
      if (existsSync(this.keyFile)) {
        // A key without its endpoint must never be paired with defaults.
        this.data.encryptedApiKey = null;
        this.notice = '接口设置文件缺失，已停用遗留密钥并保留原文件。请重新填写接口和密钥；不会使用默认地址发送请求。';
      }
      return;
    }
    const raw = readFileSync(this.file);
    try {
      const value: unknown = JSON.parse(raw.toString('utf8'));
      if (!isRecord(value) || !isRecord(value.provider) || !isRecord(value.ui)) throw new Error('shape');
      if (value.settingsFormat !== undefined && value.settingsFormat !== 1) throw new Error('future-format');
      if (value.encryptedApiKey !== undefined && value.encryptedApiKey !== null &&
        (typeof value.encryptedApiKey !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.encryptedApiKey))) throw new Error('key-shape');
      const provider = value.provider;
      if (typeof provider.baseUrl !== 'string' || !provider.baseUrl.trim()) throw new Error('provider-shape');
      this.data = { provider: normalizedProvider(provider),
        ui: structuredClone(value.ui), pricing: isRecord(value.pricing) && typeof value.pricing.input === 'number' && typeof value.pricing.output === 'number'
          ? { input: value.pricing.input, output: value.pricing.output } : null,
        ...(value.encryptedApiKey !== undefined ? { encryptedApiKey: value.encryptedApiKey as string | null } : {}),
        ...(value.settingsFormat === 1 ? { settingsFormat: 1 } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'future-format') throw new Error('设置由较新版本创建，请使用对应版本打开；原文件未修改。');
      this.damagedSettings = raw;
      // Never pair a surviving old key with a guessed/default endpoint.
      this.data.encryptedApiKey = null;
      this.notice = '设置文件损坏或版本不受支持，原文件已保留，AI 请求已停用。请在设置页重新填写接口并保存；保存前会保留原文件副本。';
    }
  }
  get recoveryWarning(): string { this.apiKey; return this.notice; }
  get apiKey(): string {
    const value = this.data.encryptedApiKey;
    if (value === null) return '';
    const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : existsSync(this.keyFile) ? readFileSync(this.keyFile) : Buffer.alloc(0);
    if (!bytes.length) return '';
    if (!this.encryption.isEncryptionAvailable()) {
      this.notice = '系统密钥加密服务不可用，已停用保存的密钥。请恢复系统加密服务后重试；不会使用明文密钥。';
      return '';
    }
    try { return this.encryption.decryptString(bytes); }
    catch {
      this.notice = '已保存的密钥无法解密，原文件已保留。请在设置页重新输入密钥；不会把旧文件当明文使用。';
      return '';
    }
  }
  private encryptedKey(key: string): string | null {
    if (!key) return null;
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥加密服务不可用，未保存密钥，请稍后重试。');
    try { return this.encryption.encryptString(key).toString('base64'); }
    catch { throw new Error('密钥加密失败，未修改已保存的设置。'); }
  }
  private commit(next: Persisted, explicitRecovery = false): void {
    if (this.damagedSettings && !explicitRecovery) throw new Error('设置文件需要恢复，请先在设置页重新填写接口并保存。原文件未被覆盖。');
    // Migrate ciphertext, never plaintext. A cleared/migrated key will no longer
    // fall back to the old apikey.bin, even after restarting the application.
    if (next.encryptedApiKey === undefined) {
      const legacyKey = this.apiKey;
      if (existsSync(this.keyFile) && readFileSync(this.keyFile).length && !legacyKey) throw new Error(this.notice || '旧密钥无法安全迁移，请重新输入密钥。');
      next = { ...next, encryptedApiKey: this.encryptedKey(legacyKey) };
    }
    next = { ...next, settingsFormat: 1 };
    if (this.damagedSettings) writeFileSync(`${this.file}.damaged-${randomUUID()}`, this.damagedSettings, { flag: 'wx', mode: 0o600 });
    // Endpoint and ciphertext are committed together; a partial save must never
    // associate a newly entered key with the previous endpoint (or vice versa).
    this.write(this.file, JSON.stringify(next, null, 2));
    this.data = next;
    this.damagedSettings = null;
    this.notice = '';
  }
  setApiKey(key: string): void { this.commit({ ...this.data, encryptedApiKey: this.encryptedKey(key) }); }
  get provider(): ProviderSettings {
    return { ...this.data.provider, hasApiKey: !!this.apiKey,
      pricingInput: this.data.pricing?.input ?? null, pricingOutput: this.data.pricing?.output ?? null };
  }
  updateProvider(patch: Partial<ProviderSettings> & { apiKey?: string }): ProviderSettings {
    const { apiKey, hasApiKey: _has, pricingInput, pricingOutput, ...rest } = patch;
    const input = pricingInput === undefined ? this.data.pricing?.input ?? null : pricingInput;
    const output = pricingOutput === undefined ? this.data.pricing?.output ?? null : pricingOutput;
    const next: Persisted = {
      ...this.data, provider: normalizedProvider({ ...this.data.provider, ...rest }),
      pricing: input !== null && output !== null ? { input, output } : null,
    };
    // The UI promises an empty field leaves an existing key unchanged. Explicit
    // deletion uses setApiKey(''); normal saving cannot silently erase a key.
    if (apiKey) next.encryptedApiKey = this.encryptedKey(apiKey);
    this.commit(next, true);
    return this.provider;
  }
  get ui(): Record<string, unknown> { return structuredClone(this.data.ui); }
  setUi(patch: Record<string, unknown>): void { this.commit({ ...this.data, ui: structuredClone({ ...this.data.ui, ...patch }) }); }
  toProviderConfig(_model?: string): ProviderConfig {
    const p = this.data.provider;
    return { baseUrl: p.baseUrl, protocol: p.protocol, model: TRANSLATION_PROFILE.model, apiKey: this.apiKey,
      authScheme: p.authScheme, temperature: p.temperature, maxOutputTokens: p.maxOutputTokens,
      timeoutMs: p.timeoutMs, thinkingMode: 'disabled', pricing: this.data.pricing };
  }
  toPreprocessingConfig(): ProviderConfig { return this.toProviderConfig(); }
  toClientConfig(): AiClientConfig {
    return { translationThinkingPolicy:TRANSLATION_THINKING_POLICY, primary: this.toProviderConfig(), judge: this.data.provider.judgeModel ? this.toProviderConfig() : null,
      concurrency: this.data.provider.concurrency, networkRetries: 3 };
  }
}
