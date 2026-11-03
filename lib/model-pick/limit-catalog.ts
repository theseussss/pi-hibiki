/** Offline, read-only metadata compatibility boundary; never resolve credentials.
 * A directory reference is not a promise of upstream capacity. Unknown projected
 * or refreshed bases stay unknown; reset deletes fields and lets Pi recompute. */
import { types } from 'node:util';
import type { ModelLimitValues } from './store.js';

interface RegistryMetadata {
  getRegisteredProviderConfig?(provider: string): unknown;
  getRegisteredNativeProvider?(provider: string): unknown;
}
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && 'value' in d ? d.value : undefined;
}
function has(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && !types.isProxy(value) && Object.hasOwn(value, key);
}
function mapValue(value: unknown, key: string): unknown {
  return types.isMap(value) && !types.isProxy(value) ? Map.prototype.get.call(value, key) : undefined;
}
export function limitPair(value: unknown): { contextWindow: number; maxTokens: number } | null {
  const contextWindow = data(value, 'contextWindow'), maxTokens = data(value, 'maxTokens');
  return typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
    && typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0
    ? { contextWindow, maxTokens } : null;
}
function oneChat(models: unknown, id: string): ModelLimitValues | null {
  if (!Array.isArray(models) || types.isProxy(models)) return null;
  const matches = Array.prototype.filter.call(models, (m: unknown) => data(m, 'id') === id && (data(m, 'type') === undefined || data(m, 'type') === 'chat'));
  return matches.length === 1 ? limitPair(matches[0]) : null;
}
/** Pi 1.4 composes virtual aliases AFTER modelOverrides: writing such an ID is
 * ignored. Explicitly exclude them instead of reporting fictitious success. */
export function isVirtualLimitTarget(registry: unknown, provider: string, id: string, version: string): boolean {
  if (version !== '1.4.0') return true;
  const virtuals = mapValue(data(data(registry, 'runtime'), 'virtualModels'), provider);
  return types.isMap(virtuals) && !types.isProxy(virtuals) && Map.prototype.has.call(virtuals, id);
}
export interface LimitCatalog { catalog: ModelLimitValues | null; catalogNote?: string }
export function readLimitCatalog(registry: RegistryMetadata, provider: string, id: string, version: string,
  hasLocalDefinition: boolean): LimitCatalog {
  const unknown = (catalogNote: string): LimitCatalog => ({ catalog: null, catalogNote });
  if (version !== '1.4.0') return unknown('未验证此 Pi 版本的基础目录；重置后以重新加载的生效值为准。');
  try {
    const registration = registry.getRegisteredProviderConfig?.(provider);
    if (registration) {
      if (typeof registration !== 'object' || types.isProxy(registration)) return unknown('扩展基础定义无法安全读取；重置后以 Pi 生效值为准。');
      if (has(registration, 'refreshModels') || has(data(registration, 'oauth'), 'modifyModels')
        || has(registration, 'oauth') && data(registration, 'oauth') === undefined) {
        return unknown('动态目录或账户投影可能调整基础值；重置后由 Pi 重新计算。');
      }
      if (has(registration, 'models')) {
        const catalog = oneChat(data(registration, 'models'), id);
        return catalog ? { catalog } : unknown('无法可靠取得扩展模型的基础值；重置后以 Pi 生效值为准。');
      }
    }
    // Native extension code may own dynamic model state; do not invoke its
    // getModels/auth/refresh callbacks merely to manufacture a reset preview.
    if (registry.getRegisteredNativeProvider?.(provider)) return unknown('此扩展维护自己的基础目录；重置后以 Pi 生效值为准。');
    if (hasLocalDefinition) return unknown('此模型还有本地基础定义；重置仅移除这两项覆盖，再由 Pi 按定义重新计算。');
    // Narrow Pi 1.4-only read of the ALREADY LOADED builtin catalog, including
    // cached overlays. No bundled-table guess, profile/config read or refresh.
    const builtin = mapValue(data(data(registry, 'runtime'), 'builtins'), provider);
    const getModels = data(builtin, 'getModels');
    const catalog = typeof getModels === 'function' ? oneChat(getModels.call(builtin), id) : null;
    return catalog ? { catalog, catalogNote: '目录为当前已加载的基础参考；重置后的最终值由 Pi 重新加载决定。' }
      : unknown('基础目录参考暂不可用；留空仍可恢复继承，最终值在 Pi 重新加载后确认。');
  } catch {
    return unknown('无法可靠读取基础目录；未调用认证或联网发现，重置后以 Pi 生效值为准。');
  }
}
