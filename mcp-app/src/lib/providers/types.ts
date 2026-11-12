/**
 * واجهة المزودات — كل خطأ يُرمى كـ ProviderError ليُصنَّف في classifyProviderError.
 */
import type { ProviderId } from "../models";
import { ProviderError } from "../errors";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

export interface ProviderTaskHandle {
  providerTaskId: string;
  /** للصور المتزامنة (CometAPI تعيد النتيجة فورًا) */
  syncUrls?: string[];
}

export interface ProviderCheck {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ProviderAdapter {
  createTask(apiKey: string, providerModel: string, input: Record<string, unknown>): Promise<ProviderTaskHandle>;
  checkTask(apiKey: string, providerTaskId: string): Promise<ProviderCheck>;
}

export function getAdapter(provider: string): ProviderAdapter {
  switch (provider as ProviderId) {
    case "kie":
      return kieAdapter;
    case "cometapi":
      return cometapiAdapter;
    default:
      throw new ProviderError(500, `مزود غير معروف: ${provider}`);
  }
}
