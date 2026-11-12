/** أنواع مشتركة لأدوات MCP — توضيح مستقل لتجنب التدوير الدائري بين الوحدات */

export interface Notify {
  (progress: number, total: number, message: string): Promise<void> | void;
}

export interface RunResult {
  text: string;
  isError?: boolean;
  taskId?: string;
}
