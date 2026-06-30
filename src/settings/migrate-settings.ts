// src/settings/migrate-settings.ts
//
// Templater 风格设置版本化迁移。
// 每次修改 DEFAULT_SETTINGS 结构时，递增 DATA_VERSION 并添加迁移函数。

import type { NutriAgentSettings } from "../main";

const DATA_VERSION = 2;

export interface MigrationResult {
    settings: NutriAgentSettings;
    wasMigrated: boolean;
    migrationNotes: string[];
}

/**
 * 加载设置后调用。检测 data_version，按需执行迁移链。
 * 当前版本: v1 (最新，无需迁移)
 */
export function migrateSettings(
    raw: unknown,
    defaults: NutriAgentSettings
): MigrationResult {
    const rawObj = (raw as Record<string, unknown>) || {};
    const version = typeof rawObj["data_version"] === "number"
        ? rawObj["data_version"] as number
        : 0;

    const notes: string[] = [];

    // v0 → v1: 初始版本标记
    if (version < 1) {
        notes.push("设置已升级到 v1（初始版本标记）");
    }

    // v1 → v2: 放纵日自选餐系统
    if (version < 2) {
        if (!rawObj["cheatDaySelections"]) (rawObj as any)["cheatDaySelections"] = {};
        if (!rawObj["cheatDayMode"]) (rawObj as any)["cheatDayMode"] = {};
        notes.push("v1→v2: 新增放纵日自选餐系统");
    }

    // 未来迁移示例:
    // if (version < 2) {
    //     // migrateV1ToV2
    //     notes.push("v1→v2: 字段X重命名为Y");
    // }

    const settings = Object.assign({}, defaults, rawObj, {
        data_version: DATA_VERSION,
    }) as NutriAgentSettings;

    return {
        settings,
        wasMigrated: version < DATA_VERSION,
        migrationNotes: notes,
    };
}
