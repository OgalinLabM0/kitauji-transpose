import type { ProviderConfig } from './providers/adapter';

/** Only a masked suffix is retained. A short key must not be exposed in full. */
export function maskedCredential(key: string, authScheme: ProviderConfig['authScheme']): string {
  if (authScheme === 'none') return '未使用';
  if (!key) return '未设置';
  return key.length > 4 ? `****${key.slice(-4).replace(/[^a-zA-Z0-9]/g, '*')}` : '****';
}
export function redactCredential(text: string, key: string): string {
  if (!key) return text;
  return [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)].reduce((value, secret) => value.split(secret).join('[密钥已隐藏]'), text);
}
export function requestIdentity(provider: ProviderConfig): string {
  const effort = provider.thinkingMode === 'disabled' ? '关闭（disabled）' : provider.thinkingMode === 'auto' ? '服务商默认（auto）' : `开启（${provider.reasoningEffort ?? '服务商默认强度'}）`;
  return `${redactCredential(provider.model, provider.apiKey)} · 思考配置：${effort} · 密钥：${maskedCredential(provider.apiKey, provider.authScheme)}`;
}
