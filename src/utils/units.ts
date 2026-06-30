// src/utils/units.ts — PantryFin v2.0
//
// Tandoor base_unit 模型: 数值与单位分列存储。
// 所有计算只做 base 值的加减法。单位转换只在系统边界发生。

import { getFoodDatabase } from "../nutrition/FoodDatabase";
// 管线: normalize(raw) → add/sub(baseVal, amount) → formatBase(val, baseUnit)

// ══════════════════════════════════════════════════════
//  单位注册表 (加新单位只加一行)
// ══════════════════════════════════════════════════════

interface UnitDef {
    base: string;       // 基准单位 (g / ml / 枚)
    dimension: string;  // 物理维度 (weight / volume / piece)
    rate: number;       // 1 base_unit = rate * this_unit
}

const UNIT_REGISTRY: Record<string, UnitDef> = {
    // ── 重量 → base: g ──
    "g":  { base: "g",  dimension: "weight", rate: 1 },
    "kg": { base: "g",  dimension: "weight", rate: 1000 },
    "KG": { base: "g",  dimension: "weight", rate: 1000 },
    "Kg": { base: "g",  dimension: "weight", rate: 1000 },
    "公斤":{ base: "g",  dimension: "weight", rate: 1000 },
    "千克":{ base: "g",  dimension: "weight", rate: 1000 },
    "斤": { base: "g",  dimension: "weight", rate: 500 },
    "两": { base: "g",  dimension: "weight", rate: 50 },
    "克": { base: "g",  dimension: "weight", rate: 1 },

    // ── 体积 → base: ml ──
    "ml":  { base: "ml", dimension: "volume", rate: 1 },
    "ML":  { base: "ml", dimension: "volume", rate: 1 },
    "毫升":{ base: "ml", dimension: "volume", rate: 1 },
    "L":   { base: "ml", dimension: "volume", rate: 1000 },
    "l":   { base: "ml", dimension: "volume", rate: 1000 },
    "升":  { base: "ml", dimension: "volume", rate: 1000 },

    // ── 计数 → base: 枚 ──
    "枚": { base: "枚", dimension: "piece", rate: 1 },
    "个": { base: "枚", dimension: "piece", rate: 1 },
    "瓶": { base: "枚", dimension: "piece", rate: 1 },
    "袋": { base: "枚", dimension: "piece", rate: 1 },
    "颗": { base: "枚", dimension: "piece", rate: 1 },
    "块": { base: "枚", dimension: "piece", rate: 1 },
    "片": { base: "枚", dimension: "piece", rate: 1 },
};

export type Dimension = "weight" | "volume" | "piece";

export interface Normalized {
    value: number;      // base 值 (g / ml / 个)
    baseUnit: string;   // 基准单位
    dimension: Dimension;
}

// ══════════════════════════════════════════════════════
//  核心函数 (仅 3 个)
// ══════════════════════════════════════════════════════

/**
 * 输入归一化: 任何单位 → base 值。
 * "1升" → {value:1000, baseUnit:"ml", dimension:"volume"}
 * "500g" → {value:500, baseUnit:"g", dimension:"weight"}
 * "200"  → {value:200, baseUnit:"g", dimension:"weight"}  // 裸数字兜底
 */
export function normalize(raw: string): Normalized | null {
    const trimmed = raw.trim();
    // 有显式单位
    const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z一-龥]+)$/);
    if (m) {
        const rawUnit = m[2]!;
        const unitDef = UNIT_REGISTRY[rawUnit] || UNIT_REGISTRY[rawUnit.toLowerCase()];
        if (!unitDef) return null;
        return {
            value: Math.round(parseFloat(m[1]!) * unitDef.rate),
            baseUnit: unitDef.base,
            dimension: unitDef.dimension as Dimension,
        };
    }
    // 无单位裸数字 → 默认 g
    const bare = trimmed.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) {
        return { value: parseFloat(bare[1]!), baseUnit: "g", dimension: "weight" };
    }
    return null;
}

/**
 * 扣减: base 值减法。永远精确，不会浮点溢出。
 */
export function subtractBase(baseVal: number, amount: number): number {
    return Math.max(0, baseVal - amount);
}

/**
 * 显示格式化: base 值 → 最佳展示单位。
 * 1000ml → "1L", 800ml → "800ml", 1500g → "1.5kg"
 */
export function formatBase(value: number, baseUnit: string): string {
    if (value === 0) return `0${baseUnit}`;

    // 体积: >=1000ml 自动升级为 L
    if (baseUnit === "ml" && value >= 1000) {
        const liters = value / 1000;
        return liters === Math.floor(liters) ? `${liters}L` : `${liters}L`;
    }
    // 重量: >=1000g 自动升级为 kg
    if (baseUnit === "g" && value >= 1000) {
        const kilos = value / 1000;
        return kilos === Math.floor(kilos) ? `${kilos}kg` : `${kilos}kg`;
    }
    return `${value}${baseUnit}`;
}

// ══════════════════════════════════════════════════════
//  兼容层 (逐步废弃)
// ══════════════════════════════════════════════════════

/** @deprecated 旧 parseQuantity — 仅用于迁移脚本 */
export function parseQuantity(raw: string): { value: number; unit: string } | null {
    const n = normalize(raw);
    if (!n) return null;
    return { value: n.value, unit: n.baseUnit };
}

/** @deprecated 旧 toBase — 仅用于迁移脚本 */
export function toBase(q: { value: number; unit: string }): number {
    const def = UNIT_REGISTRY[q.unit];
    return def ? q.value * def.rate : q.value;
}

/** @deprecated 旧 fromBase */
export function fromBase(value: number, unit: string): number {
    const def = UNIT_REGISTRY[unit];
    return def ? value / def.rate : value;
}

/** @deprecated 旧 isCompatible */
export function isCompatible(a: string, b: string): boolean {
    const da = UNIT_REGISTRY[a];
    const db = UNIT_REGISTRY[b];
    return da != null && db != null && da.dimension === db.dimension;
}

/** @deprecated 旧 COMPAT_GROUPS */
export const COMPAT_GROUPS: Record<string, string> = {};
// 启动时自动填充
for (const [k, v] of Object.entries(UNIT_REGISTRY)) {
    COMPAT_GROUPS[k] = v.dimension;
}

/** @deprecated 旧 formatQuantity */
export function formatQuantity(q: { value: number; unit: string }): string {
    return formatBase(q.value, q.unit);
}

/** @deprecated 旧 smartDeduct — 仅用于迁移脚本和测试兼容 */
export function smartDeduct(
    cur: { value: number; unit: string },
    aiAmountGrams: number
): { value: number; unit: string } | null {
    const def = UNIT_REGISTRY[cur.unit];
    if (!def) return null;

    // 计数类: 克→个 用平均重量换算
    if (def.dimension === "piece") {
        const db = getFoodDatabase();
        const avgWeight = db.getAvgWeight(cur.unit === "枚" ? "鸡蛋" : cur.unit);
        const piecesToDeduct = avgWeight > 0 ? Math.round(aiAmountGrams / avgWeight) : aiAmountGrams;
        return { value: Math.max(0, cur.value - piecesToDeduct), unit: cur.unit };
    }

    const curBase = cur.value * def.rate;
    const remaining = Math.max(0, curBase - aiAmountGrams);
    const displayVal = def.rate > 0 ? Math.round((remaining / def.rate) * 100) / 100 : remaining;
    return { value: displayVal, unit: cur.unit };
}
