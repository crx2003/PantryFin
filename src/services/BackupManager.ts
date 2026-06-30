// src/services/BackupManager.ts
//
// 全栈数据导入导出引擎 v3.0
// 移植自 Mealie backup_v2.py — 将用户全部数据资产打包为 JSON
// 支持：设置、食谱替换记录、食材别名、打卡历史、库存数据

import type NutriAgentPlugin from "../main";

export interface BackupPayload {
  version: string;
  exportedAt: string;
  pluginVersion: string;
  settings: {
    profilePath: string;
    pantryPath: string;
    mealPlanFolder: string;
    scheduledTime: string;
    autoGenerate: boolean;
    aiProviderMode?: string;
    apiBaseUrl?: string;
    apiModel?: string;
    mealReplacements?: Record<string, any>;
    foodAliases?: Record<string, string>;
    acceptedMealTicks?: Record<string, string[]>;
    showCard?: Record<string, boolean>;
    chatHistory?: Record<string, Array<{ sender: string; text: string }>>;
  };
}

export class BackupManager {
  constructor(private plugin: NutriAgentPlugin) {}

  /** 导出全部数据 → JSON 字符串 */
  exportAll(): string {
    const s = this.plugin.settings;
    const payload: BackupPayload = {
      version: "3.0",
      exportedAt: new Date().toISOString(),
      pluginVersion: "2.5.0",
      settings: {
        profilePath: s.profilePath,
        pantryPath: s.pantryPath,
        mealPlanFolder: s.mealPlanFolder,
        scheduledTime: s.scheduledTime,
        autoGenerate: s.autoGenerate,
        aiProviderMode: s.aiProviderMode,
        apiBaseUrl: s.apiBaseUrl,
        apiModel: s.apiModel,
        mealReplacements: s.mealReplacements,
        foodAliases: s.foodAliases,
        acceptedMealTicks: s.acceptedMealTicks,
        showCard: s.showCard,
        chatHistory: s.chatHistory,
      },
    };
    return JSON.stringify(payload, null, 2);
  }

  /** 导入 JSON → 写回设置（合并模式，不覆盖 API Key 等敏感字段） */
  importAll(json: string): { success: boolean; message: string } {
    try {
      const payload = JSON.parse(json) as BackupPayload;

      // 基础校验
      if (!payload.version || !payload.settings) {
        return { success: false, message: "无效的备份文件格式" };
      }

      const s = this.plugin.settings;
      const bs = payload.settings;

      // 安全合并：只恢复备份中存在且非空的字段
      if (bs.profilePath) s.profilePath = bs.profilePath;
      if (bs.pantryPath) s.pantryPath = bs.pantryPath;
      if (bs.mealPlanFolder) s.mealPlanFolder = bs.mealPlanFolder;
      if (bs.scheduledTime) s.scheduledTime = bs.scheduledTime;
      if (typeof bs.autoGenerate === "boolean") s.autoGenerate = bs.autoGenerate;
      if (bs.mealReplacements) s.mealReplacements = bs.mealReplacements;
      if (bs.foodAliases) s.foodAliases = bs.foodAliases;
      if (bs.acceptedMealTicks) s.acceptedMealTicks = bs.acceptedMealTicks;
      if (bs.showCard) s.showCard = bs.showCard;
      if (bs.chatHistory) s.chatHistory = bs.chatHistory;

      // 不恢复敏感字段：apiKey 保留现有值
      // 不恢复 aiProviderMode/apiBaseUrl/apiModel — 用户在新环境需重新配置

      this.plugin.saveSettings();
      return { success: true, message: `已恢复 ${exportedAt(payload)}` };
    } catch (e) {
      return { success: false, message: `解析失败: ${(e as Error).message}` };
    }
  }
}

function exportedAt(p: BackupPayload): string {
  try {
    return new Date(p.exportedAt).toLocaleString("zh-CN");
  } catch {
    return "未知日期";
  }
}
