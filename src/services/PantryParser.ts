// src/services/PantryParser.ts — PantryFin v2.0
//
// 5 列库存表: | 类别 | 名称 | 数量(base值) | 单位(base单位) | 采购日期 |
// 所有运算只做 base 值的加减法，单位转换只在 normalize/formatBase 边界。

import { App, TFile, Notice } from "obsidian";
import { PantryItem, ConsumeItem, PantryPriority } from "../models/types";
import { normalize, formatBase } from "../utils/units";
import { getFoodDatabase } from "../nutrition/FoodDatabase";

export class PantryParser {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * 从 Pantry.md 读取库存。自动检测并迁移旧表(4列) → 新表(5列)。
   */
  async readPantry(pantryPath: string): Promise<PantryItem[]> {
    const file = this.app.vault.getAbstractFileByPath(pantryPath);
    if (!(file instanceof TFile)) return [];
    const content = await this.app.vault.read(file);
    // 先尝试迁移
    const migrated = this._migrateIfOld(content);
    if (migrated !== content) {
      // 迁移前备份
      const backupPath = pantryPath.replace(/\.md$/, ".backup_v1_to_v2.md");
      if (!this.app.vault.getAbstractFileByPath(backupPath)) {
        await this.app.vault.create(backupPath, content);
      }
      await this.app.vault.modify(file, migrated);
      return this._parseNewTable(migrated);
    }
    return this._parseNewTable(content);
  }

  /**
   * 扣减库存: base 值纯减法。
   */
  async deductStock(pantryPath: string, consumeList: ConsumeItem[]): Promise<{ warnings: string[]; actualDeducted: Array<{ name: string; amount_g: number }> }> {
    const file = this.app.vault.getAbstractFileByPath(pantryPath);
    if (!(file instanceof TFile)) return { warnings: [], actualDeducted: [] };

    let content = await this.app.vault.read(file);
    content = this._migrateIfOld(content);
    const lines = content.split("\n");
    const warnings: string[] = [];

    const deductMap = new Map<string, number>();
    for (const item of consumeList) {
      deductMap.set(item.name, (deductMap.get(item.name) ?? 0) + item.amount_g);
    }

    const updatedLines = lines.map((line) => {
      if (!line.startsWith("|") || line.includes("---") || line.includes("食材名称")) return line;
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length < 5) return line;

      const name = cells[1]!;
      const deductAmount = deductMap.get(name);
      if (deductAmount === undefined) return line;

      const curBaseRaw = parseFloat(cells[2]!);
      if (isNaN(curBaseRaw)) return line;

      const rawUnit = cells[3]!;
      const rowNorm = normalize(`${curBaseRaw}${rawUnit}`);
      const curBase = rowNorm ? rowNorm.value : curBaseRaw;
      const baseUnit = rowNorm ? rowNorm.baseUnit : rawUnit;

      // 计数类食材: AI 的 amount_g 是克 → 用平均重量转为个数
      let actualDeduct = deductAmount;
      if (baseUnit === "枚") {
        const db = getFoodDatabase();
        const avgWeight = db.getAvgWeight(name);
        if (avgWeight > 0) {
          actualDeduct = Math.round(deductAmount / avgWeight);
        }
      }

      const remaining = Math.max(0, curBase - actualDeduct);

      if (remaining <= 0) {
        warnings.push(`${name} 已消耗完毕，请尽快采购！`);
      } else if (curBase > 0 && remaining < curBase * 0.3) {
        warnings.push(`${name} 剩余 ${formatBase(remaining, baseUnit)}，库存较低。`);
      }

      cells[2] = String(remaining);
      cells[3] = baseUnit;
      return `| ${cells.join(" | ")} |`;
    });

    // 返回实际扣减量(已转换计数类食材), 供 revert 精确恢复
    const actualDeducted: Array<{ name: string; amount_g: number }> = [];
    for (const [name, rawAmount] of deductMap) {
      // 查找该食材的 base 单位以判断是否需要克→个转换
      let actualAmount = rawAmount;
      for (const line of lines) {
        if (!line.startsWith("|") || line.includes("---")) continue;
        const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
        if (cells.length >= 5 && cells[1] === name) {
          const rowNorm = normalize(`${cells[2]!}${cells[3]!}`);
          const unit = rowNorm ? rowNorm.baseUnit : cells[3]!;
          if (unit === "枚") {
            const db = getFoodDatabase();
            const avgWeight = db.getAvgWeight(name);
            if (avgWeight > 0) actualAmount = Math.round(rawAmount / avgWeight);
          }
          break;
        }
      }
      actualDeducted.push({ name, amount_g: actualAmount });
    }

    await this.app.vault.modify(file, updatedLines.join("\n"));
    return { warnings, actualDeducted };
  }

  /**
   * 扣减库存(简化版, 不返回实际扣减量)。
   * @deprecated 请使用 deductStock 并读取返回的 actualDeducted
   */
  async deductStockSimple(pantryPath: string, consumeList: ConsumeItem[]): Promise<string[]> {
    const result = await this.deductStock(pantryPath, consumeList);
    return result.warnings;
  }

  /** 追加新食材 */
  async addItem(pantryPath: string, item: PantryItem): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pantryPath);
    if (!(file instanceof TFile)) return;
    let content = await this.app.vault.read(file);
    content = this._migrateIfOld(content);
    const n = normalize(item.quantity);
    if (!n) return;
    const newLine = `| ${item.category} | ${item.name} | ${n.value} | ${n.baseUnit} | ${item.purchaseDate} |`;
    await this.app.vault.modify(file, content.trimEnd() + "\n" + newLine + "\n");
  }

  /** 手动录入/合并：输入归一化后纯数值加法 */
  async manualAddOrMergeItem(
    pantryPath: string, category: string, name: string,
    quantityStr: string, _expiryDate?: string
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(pantryPath);
    if (!(file instanceof TFile)) return;

    let content = await this.app.vault.read(file);
    content = this._migrateIfOld(content);
    const lines = content.split("\n");

    const addNorm = normalize(quantityStr);
    if (!addNorm) {
      new Notice(`❌ 无法识别单位格式: "${quantityStr}"。请用如 500g、1L、10枚 的格式。`);
      return;
    }

    const d = new Date();
    const todayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

    let merged = false;
    const updatedLines = lines.map((line) => {
      if (!line.startsWith("|") || line.includes("---") || line.includes("食材名称")) return line;
      const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length < 5) return line;

      if (cells[1] === name) {
        merged = true;
        const rowNorm = normalize(`${cells[2]!}${cells[3]!}`);
        const curVal = rowNorm ? rowNorm.value : (parseFloat(cells[2]!) || 0);
        const curUnit = rowNorm ? rowNorm.baseUnit : cells[3]!;
        cells[2] = String(curVal + addNorm.value);
        cells[3] = curUnit;
        return `| ${cells.join(" | ")} |`;
      }

      return line;
    });

    if (merged) {
      await this.app.vault.modify(file, updatedLines.join("\n"));
      new Notice(`🔄 已合并更新库存：${name} (+${formatBase(addNorm.value, addNorm.baseUnit)})`);
    } else {
      const newLine = `| ${category || "食材"} | ${name} | ${addNorm.value} | ${addNorm.baseUnit} | ${todayStr} |`;
      await this.app.vault.modify(file, content.trimEnd() + "\n" + newLine + "\n");
      new Notice(`✅ 成功录入：${name} (${formatBase(addNorm.value, addNorm.baseUnit)})`);
    }
  }

  // ══════════════════════════════════════════════════════
  //  迁移引擎
  // ══════════════════════════════════════════════════════

  /** 检测旧表(4列)并自动迁移到新表(5列)。逐行处理，兼容表头已升级但数据行未升级的混合状态。 */
  private _migrateIfOld(content: string): string {
    const lines = content.split("\n");
    let hasOldRows = false;
    const newLines: string[] = [];

    for (const line of lines) {
      // 升级旧表头
      if (line.includes("食材名称") && !line.includes("单位")) {
        hasOldRows = true;
        newLines.push(line.replace(
          /当前数量\/克重\s*\|\s*采购日期/,
          "数量 | 单位 | 采购日期"
        ));
        continue;
      }

      // 跳过表头分隔线
      if (line.match(/^\|[\s:-]+\|/)) {
        // 旧表头分隔线(4列) → 扩展为 5 列
        if (hasOldRows || line.split("|").filter(c => c.includes("---")).length <= 3) {
          newLines.push(line.replace(/:---\s*\|\s*:---$/, ":--- | :--- | :---"));
          continue;
        }
        newLines.push(line);
        continue;
      }

      // 数据行: 检测并迁移旧行(4列→5列)
      if (line.startsWith("|") && !line.includes("---")) {
        const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
        // 旧行(4列): 类别/名称/数量+单位/日期 → 需迁移
        if (cells.length === 4) {
          const qty = cells[2] || "0g";
          const n = normalize(qty);
          if (n) {
            hasOldRows = true;
            const purchaseDate = cells[3] || new Date().toISOString().split("T")[0];
            newLines.push(`| ${cells[0]} | ${cells[1]} | ${n.value} | ${n.baseUnit} | ${purchaseDate} |`);
            continue;
          }
        }
      }

      newLines.push(line);
    }

    return newLines.join("\n");
  }

  /** 解析新表(5列) */
  private _parseNewTable(content: string): PantryItem[] {
    const items: PantryItem[] = [];
    const lines = content.split("\n");
    let headerFound = false;

    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.includes("食材名称")) { headerFound = true; continue; }
      if (line.match(/^\|[\s:-]+\|/)) continue;
      if (!headerFound) continue;
      if (!line.startsWith("|")) continue;

      const cells = line.split("|").map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length >= 5) {
        const baseVal = parseFloat(cells[2]!) || 0;
        const baseUnit = cells[3]!;
        items.push({
          category:     cells[0]!,
          name:         cells[1]!,
          quantity:     formatBase(baseVal, baseUnit),  // 展示用格式
          purchaseDate: cells[4]!,
          expiryDate:   "",
          priority:     "🟢 充足",
        });
      }
    }
    return items;
  }
}
