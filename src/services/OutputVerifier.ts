// src/services/OutputVerifier.ts
//
// Layer 3: AI 输出本地验证引擎。
// 在 AI 返回结果后、执行扣减/入库前，验证：
//   1. 食材名是否在库存中存在
//   2. 消耗量是否合理（不超过现有库存）
//   3. 营养数据是否存在明显异常
// 防止 AI 幻觉污染本地库存数据。
//
// 借鉴 obsidian-react-components ErrorBoundary 的隔离思想：
//   AI 的输出是不可信的，需要本地确定性验证后才能执行。

import { PantryItem, ConsumeItem } from "../models/types";
import { MenuCalculator } from "../nutrition/menu-calculator";
import { FoodDataLoader } from "../nutrition/fooddata-loader";

// ── 单条验证结果 ──────────────────────────────────────────
export interface ItemVerification {
  item: ConsumeItem;
  passed: boolean;
  issue?: string;
  severity: "ok" | "warning" | "error";
}

// ── 整体验证报告 ──────────────────────────────────────────
export interface VerificationReport {
  /** 所有验证通过的条目 */
  safe: ConsumeItem[];
  /** 需要用户确认的条目 */
  needsConfirmation: ItemVerification[];
  /** 被拦截拒绝的条目 */
  rejected: ItemVerification[];
  /** 全局警告信息 */
  warnings: string[];
  /** 是否全部通过 */
  allPassed: boolean;
}

// ══════════════════════════════════════════════════════════
export class OutputVerifier {
  private menuCalculator: MenuCalculator;
  private foodLoader: FoodDataLoader;

  // 营养素异常阈值
  private readonly MAX_SINGLE_ITEM_ENERGY = 3000; // 单项食材超 3000kcal 视为异常
  private readonly MAX_SINGLE_ITEM_PROTEIN = 500; // 单项蛋白质超 500g 视为异常

  constructor(menuCalculator: MenuCalculator, foodLoader: FoodDataLoader) {
    this.menuCalculator = menuCalculator;
    this.foodLoader = foodLoader;
  }

  /**
   * 全面验证 AI 返回的消耗列表。
   * 返回 VerificationReport，调用方根据报告决定执行或请求用户确认。
   */
  async verify(
    consumeItems: ConsumeItem[],
    pantry: PantryItem[]
  ): Promise<VerificationReport> {
    const safe: ConsumeItem[] = [];
    const needsConfirmation: ItemVerification[] = [];
    const rejected: ItemVerification[] = [];
    const warnings: string[] = [];

    if (consumeItems.length === 0) {
      return { safe, needsConfirmation, rejected, warnings, allPassed: true };
    }

    // 构建库存查找索引
    const pantryByName = new Map<string, PantryItem>();
    for (const p of pantry) {
      pantryByName.set(p.name, p);
    }

    for (const item of consumeItems) {
      // ── 1. 存在性验证 ──
      if (!item.name || item.name.trim().length === 0) {
        rejected.push({
          item,
          passed: false,
          issue: "食材名为空",
          severity: "error",
        });
        continue;
      }

      let pantryItem = pantryByName.get(item.name);

      // ── 2. 克重合理性 ──
      if (!item.amount_g || item.amount_g <= 0 || item.amount_g > 10000) {
        rejected.push({
          item,
          passed: false,
          issue: `消耗量 ${item.amount_g}g 不合理（应在 1-10000g 范围内）`,
          severity: "error",
        });
        continue;
      }

      // ── 3. 库存匹配验证（模糊匹配：双向包含） ──
      if (!pantryItem) {
        // 尝试模糊匹配: "番茄"↔"西红柿", "鸡蛋(大号)"↔"鸡蛋"
        const fuzzyMatch = [...pantryByName.keys()].find((k: string) =>
          k.includes(item.name) || item.name.includes(k)
        );
        if (fuzzyMatch) {
          pantryItem = pantryByName.get(fuzzyMatch)!;
        }
      }
      if (!pantryItem) {
        // 不在库存中 → 警告但允许通过（可能是基础调料：盐、油、酱油等）
        needsConfirmation.push({
          item,
          passed: true, // 不拦截，但需要用户知晓
          issue: `「${item.name}」不在当前库存中，将视为基础调料直接扣减`,
          severity: "warning",
        });
        safe.push(item);
        continue;
      }

      // ── 4. 库存充足性验证 ──
      const qtyMatch = pantryItem.quantity.match(/(\d+(?:\.\d+)?)/);
      if (qtyMatch && qtyMatch[1]) {
        const currentGrams = parseFloat(qtyMatch[1]);
        if (item.amount_g > currentGrams * 1.5) {
          needsConfirmation.push({
            item,
            passed: true,
            issue: `「${item.name}」消耗 ${item.amount_g}g 远超库存 ${pantryItem.quantity}`,
            severity: "warning",
          });
        }
      }

      // ── 5. 营养合理性验证 ──
      try {
        const nutritionText = `${item.name} ${item.amount_g}g`;
        const calcResult = await this.menuCalculator.calculate(nutritionText, {
          loader: this.foodLoader,
        });
        const energy = calcResult.total["Energy"] || 0;
        const protein = calcResult.total["Protein"] || 0;

        if (energy > this.MAX_SINGLE_ITEM_ENERGY) {
          warnings.push(
            `⚠️ 「${item.name}」${item.amount_g}g 估算热量 ${Math.round(energy)}kcal 异常偏高`
          );
        }
        if (protein > this.MAX_SINGLE_ITEM_PROTEIN) {
          warnings.push(
            `⚠️ 「${item.name}」${item.amount_g}g 估算蛋白质 ${Math.round(protein)}g 异常偏高`
          );
        }
      } catch {
        // 营养计算失败不拦截，仅记录
        warnings.push(`⚠️ 无法计算「${item.name}」的营养数据`);
      }

      // ── 全部验证通过 ──
      safe.push(item);
    }

    const allPassed = rejected.length === 0 && needsConfirmation.length === 0;

    return { safe, needsConfirmation, rejected, warnings, allPassed };
  }

  /**
   * 生成用户可读的验证报告文本。
   */
  formatReport(report: VerificationReport): string {
    const parts: string[] = [];

    if (report.safe.length > 0) {
      parts.push(
        `✅ 验证通过 ${report.safe.length} 项: ${report.safe.map((i) => `${i.name} ${i.amount_g}g`).join("、")}`
      );
    }

    for (const v of report.needsConfirmation) {
      parts.push(`${v.severity === "warning" ? "⚠️" : "ℹ️"} ${v.issue}`);
    }

    for (const v of report.rejected) {
      parts.push(`🚫 ${v.issue}`);
    }

    for (const w of report.warnings) {
      parts.push(w);
    }

    return parts.join("\n");
  }
}
