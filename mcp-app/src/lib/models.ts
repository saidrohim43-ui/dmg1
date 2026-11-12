/**
 * سجل الموديلات — الأسماء كما يراها عميل MCP (canonical) + الصيغ البديلة المقبولة (aliases بالنقاط).
 * أسماء الموديلات لدى كل مزود قابلة للتجاوز بمتغيرات البيئة.
 */
export type ProviderId = "kie" | "cometapi";
export type MediaType = "image" | "video";

export interface ModelDef {
  canonical: string;
  aliases: string[];
  type: MediaType;
  providers: ProviderId[];
  providerModel: Record<ProviderId, string>;
}

const env = (k: string) => (process.env[k] || "").trim();

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env("KIE_IMAGE_MODEL") || "gpt-image-2-6/flare-text-to-image",
      cometapi: env("COMETAPI_IMAGE_MODEL") || "gpt-image-2.6-flare-text-to-image",
    },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env("KIE_VIDEO_MODEL") || "grok-imagine-video-1-5-preview",
      cometapi: env("COMETAPI_VIDEO_MODEL") || "grok-imagine-video-1-5-preview",
    },
  },
];

/** يوحّد اسم الموديل عبر aliases — يعيد null إن كان مجهولًا؛ وبدون اسم يعيد الافتراضي لنوع الطلب */
export function resolveModel(name: string | undefined, type?: MediaType): ModelDef | null {
  const s = (name ?? "").trim();
  if (!s) return MODELS.find((m) => m.type === type) ?? null;
  return MODELS.find((m) => m.canonical === s || m.aliases.includes(s)) ?? null;
}
