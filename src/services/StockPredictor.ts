// src/services/StockPredictor.ts
//
// 智能库存预警 (Grocy EverShelf 精简融合版)
// - 类别阈值: 肉类5/3天, 蔬菜2/1天, 其他5/3天
// - 7天滑动窗口日均消耗
// - 最少3条记录才预测 (EverShelf 数据门槛)
// - 只报告"即将不足" (EverShelf 单向预警)
// - 缺货自动生成采购待办文本 (Grocy Missing Products)

import type { PantryItem } from "../models/types";
import { parseQuantity, toBase } from "../utils/units";

// ── 类别阈值 ──────────────────────────────────────
interface Threshold { remindDays: number; warnDays: number; }
const THRESHOLDS: Record<string, Threshold> = {
    "肉类":   { remindDays: 5, warnDays: 3 },
    "蛋白质": { remindDays: 5, warnDays: 3 },
    "蔬菜":   { remindDays: 2, warnDays: 1 },
    "碳水":   { remindDays: 7, warnDays: 3 },
    "主食":   { remindDays: 7, warnDays: 3 },
    "水果":   { remindDays: 3, warnDays: 2 },
    "乳制品": { remindDays: 5, warnDays: 3 },
    "调料":   { remindDays: 14, warnDays: 7 },
    "食材":   { remindDays: 5, warnDays: 3 },
};
function getThreshold(cat: string): Threshold { return THRESHOLDS[cat] || THRESHOLDS["食材"]!; }

// ── 类型 ────────────────────────────────────────
export interface ConsumptionRecord { date: string; amount_g: number; }

export type WarningLevel = "ok" | "remind" | "warn" | "critical";

export interface StockPrediction {
    dailyRate: number;
    daysRemaining: number;
    level: WarningLevel;
    label: string;
}

export interface RestockItem {
    name: string;
    quantity: string;     // 原始数量字符串 (如 "600g", "3枚")
    dailyRate: number;
    daysRemaining: number;
    level: WarningLevel;
}

// ── 核心预测 ────────────────────────────────────

/** 7天窗口日均消耗 */
export function computeDailyRate(history: ConsumptionRecord[], windowDays = 7): number {
    if (!history || history.length === 0) return 0;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,"0")}-${String(cutoff.getDate()).padStart(2,"0")}`;
    const recent = history.filter(r => r.date >= cutoffStr);
    if (recent.length === 0) return 0;
    const totalDays = Math.max(1, Math.ceil((Date.now() - new Date(recent[0]!.date).getTime()) / 86400000));
    return recent.reduce((s, r) => s + r.amount_g, 0) / Math.max(1, Math.min(windowDays, totalDays));
}

/** 综合预测 */
export function predict(quantityStr: string, category: string, history: ConsumptionRecord[]): StockPrediction {
    const q = parseQuantity(quantityStr);
    const val = q ? q.value : 0;
    const unit = q ? q.unit : "g";

    if (val <= 0) return { dailyRate: 0, daysRemaining: 0, level: "critical", label: "已耗尽" };

    // 非重量/体积单位 (枚/个/瓶) — 不做速率预测，简单数量判定
    const weightUnits = new Set(["g", "kg", "ml", "L"]);
    if (!weightUnits.has(unit)) {
        if (val <= 1) return { dailyRate: 0, daysRemaining: 0, level: "warn", label: `⚠️ 仅剩1${unit}` };
        if (val <= 3) return { dailyRate: 0, daysRemaining: 0, level: "remind", label: `⚡ 仅剩${val}${unit}` };
        return { dailyRate: 0, daysRemaining: 999, level: "ok", label: `✅ ${val}${unit}` };
    }

    const currentGrams = toBase(q!);
    const t = getThreshold(category);
    const dailyRate = computeDailyRate(history);

    if (!history || history.length < 3) {
        if (currentGrams < 100) return { dailyRate: 0, daysRemaining: 0, level: "warn", label: "⚠️ 库存偏低" };
        if (currentGrams < 300) return { dailyRate: 0, daysRemaining: 0, level: "remind", label: "⚡ 建议补货" };
        return { dailyRate: 0, daysRemaining: 999, level: "ok", label: "✅ 充足" };
    }

    const days = dailyRate > 0 ? Math.round(currentGrams / dailyRate) : 999;

    if (days <= t.warnDays) return { dailyRate, daysRemaining: days, level: "warn", label: `⚠️ 预计${days}天后耗尽` };
    if (days <= t.remindDays) return { dailyRate, daysRemaining: days, level: "remind", label: `⚡ 预计${days}天后耗尽` };
    return { dailyRate, daysRemaining: days, level: "ok", label: dailyRate > 0 ? `✅ 约${days}天用量` : "✅ 充足" };
}

// ── Grocy 缺货检测 ──────────────────────────────

/**
 * 扫描库存，找出需要补货的食材 (Grocy GetMissingProducts)。
 * 返回补货列表 + 采购待办文本。
 */
export function findRestockItems(
    pantry: PantryItem[],
    consumptionLog: Record<string, ConsumptionRecord[]>
): RestockItem[] {
    const items: RestockItem[] = [];
    for (const p of pantry) {
        const q = parseQuantity(p.quantity);
        const history = consumptionLog[p.name] || [];
        const pred = predict(p.quantity, p.category, history);
        if (pred.level === "warn" || pred.level === "critical") {
            items.push({ name: p.name, quantity: p.quantity, dailyRate: pred.dailyRate, daysRemaining: pred.daysRemaining, level: pred.level });
        }
    }
    return items;
}

/**
 * 生成采购待办文本 (Grocy AddMissingProductsToShoppingList)
 */
export function buildShoppingTasks(restock: RestockItem[]): string[] {
    return restock.map(r => {
        const rate = r.dailyRate > 0 ? ` (日均${Math.round(r.dailyRate)}g)` : "";
        return `采购${r.name}${rate} — 当前${r.quantity}，${r.level === "critical" ? "已耗尽" : "即将不足"}`;
    });
}
