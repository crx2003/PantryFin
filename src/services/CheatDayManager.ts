// src/services/CheatDayManager.ts
//
// 餐次替换业务逻辑：用自选菜谱替换 AI 输出的某餐。
// 数据存储在 settings.mealReplacements: { "2026-06-29": { "午餐": {...} } }
// v3.0: 接入 FoodDatabase 进行 O(1) 精确营养查询

import { TFile } from "obsidian";
import type NutriAgentPlugin from "../main";
import type { MealSlot, MealReplacement, ParsedRecipe } from "../models/types";
import { getFoodDatabase, type FoodEntry } from "../nutrition/FoodDatabase";

export class CheatDayManager {
  constructor(private plugin: NutriAgentPlugin) {}

  /** 同步用户自定义食材别名到 FoodDatabase */
  private _syncAliases(): void {
    const aliases = this.plugin.settings.foodAliases;
    if (aliases) getFoodDatabase().setUserAliases(aliases);
  }

  /** O(1) 查询单个食材的营养数据（每 100g），用户别名 > FOOD_CN_MAP > 模糊搜索 */
  private _lookupIngredient(ingName: string): FoodEntry | null {
    return getFoodDatabase().lookupChinese(ingName);
  }

  /** 计算一组食材的总热量（利用 FoodDatabase O(1) 查找） */
  private _calcIngredientsCalories(
    ingredients: Array<{ name: string; amountGrams: number }>
  ): number {
    const db = getFoodDatabase();
    let total = 0;
    for (const ing of ingredients) {
      const food = db.lookupChinese(ing.name);
      if (food) {
        const energyPer100g = food.nutrients["Energy"] || 0;
        total += energyPer100g * (ing.amountGrams / 100);
      }
    }
    return Math.round(total);
  }

  /** 获取某日所有替换 */
  getReplacements(date: string): Partial<Record<MealSlot, MealReplacement>> {
    return this.plugin.settings.mealReplacements?.[date] || {};
  }

  /** 获取某日某餐的替换（可能来自预定或当天） */
  getReplacement(date: string, slot: MealSlot): MealReplacement | undefined {
    return this.plugin.settings.mealReplacements?.[date]?.[slot];
  }

  /** 设置某日某餐的替换（直接覆盖），默认 1 人份 */
  async setReplacement(
    date: string, slot: MealSlot,
    recipeId: string, recipeName: string, calories: number,
    servings = 2
  ): Promise<void> {
    this.plugin.settings.mealReplacements = this.plugin.settings.mealReplacements || {};
    if (!this.plugin.settings.mealReplacements[date]) {
      this.plugin.settings.mealReplacements[date] = {};
    }
    this.plugin.settings.mealReplacements[date]![slot] = {
      recipeId, recipeName,
      baseCalories: calories,
      servings,
      isAccepted: false,
    };
    await this.plugin.saveSettings();
  }

  /** 移除某日某餐的替换 */
  async removeReplacement(date: string, slot: MealSlot): Promise<void> {
    const mr = this.plugin.settings.mealReplacements;
    if (!mr?.[date]) return;
    delete mr[date]![slot];
    if (Object.keys(mr[date]!).length === 0) delete mr[date];
    await this.plugin.saveSettings();
  }

  /** 切换打卡 */
  async toggleAccept(date: string, slot: MealSlot): Promise<void> {
    const entry = this.getReplacement(date, slot);
    if (!entry) return;
    entry.isAccepted = !entry.isAccepted;
    await this.plugin.saveSettings();
  }

  /** 更新份量（保留用户手动调整的克重，仅重算热量） */
  async updateServings(date: string, slot: MealSlot, servings: number): Promise<void> {
    const entry = this.getReplacement(date, slot);
    if (!entry) return;
    entry.servings = Math.round(servings); // 强制整数
    // 用现有 actualQuantities（如果有）重新计算热量
    await this.updateQuantities(date, slot, {});
  }

  /** 更新用量并重算热量（差值校准算法，每次实时双算确保版本一致性） */
  async updateQuantities(
    date: string, slot: MealSlot, actualGrams: Record<string, number>
  ): Promise<number> {
    const entry = this.getReplacement(date, slot);
    if (!entry) return 0;

    // 同步用户别名 + 清理旧版脏缓存
    this._syncAliases();
    delete (entry as any)._cachedOrigCalc;

    entry.actualQuantities = { ...(entry.actualQuantities || {}), ...actualGrams };

    let recipe = this.plugin.recipeLibrary?.getRecipe(entry.recipeId);
    // 用户导入食谱：从 Markdown 文件解析食材
    if (!recipe && entry.recipeId?.startsWith("user:")) {
      recipe = await this._parseUserRecipe(entry.recipeId) ?? undefined;
    }
    if (!recipe || !this.plugin.menuCalculator) {
      entry.adjustedCalories = this._proportionalEstimate(entry, recipe);
      await this.plugin.saveSettings();
      return entry.adjustedCalories;
    }

    // servings = 几人分食：总热量 ÷ servings = 单人份热量
    const servings = entry.servings || 2;
    const validIng = recipe.ingredients.filter(i => i.amountGrams > 0);
    try {
      const origIngs = validIng.map(ing => ({
        name: ing.name,
        amountGrams: Math.round(ing.amountGrams),
      }));
      const newIngs = validIng.map(ing => ({
        name: ing.name,
        amountGrams: Math.round(entry.actualQuantities?.[ing.name] ?? ing.amountGrams),
      }));

      const origCalc = this._calcIngredientsCalories(origIngs);
      const newCalc = this._calcIngredientsCalories(newIngs);

      if (origCalc > 0 && newCalc > 0) {
        const delta = newCalc - origCalc;
        // 全份热量 + 增量，再除以份数 = 单人份热量
        entry.adjustedCalories = Math.max(0, Math.round((entry.baseCalories + delta) / servings));
      } else if (newCalc > 0) {
        entry.adjustedCalories = Math.round(newCalc / servings);
      } else {
        entry.adjustedCalories = this._proportionalEstimate(entry, recipe);
      }
    } catch {
      entry.adjustedCalories = this._proportionalEstimate(entry, recipe);
    }
    await this.plugin.saveSettings();
    return entry.adjustedCalories;
  }

  /** 解析用户导入的食谱 Markdown → 提取食材列表 */
  private async _parseUserRecipe(recipeId: string): Promise<ParsedRecipe | null> {
    const filePath = recipeId.replace("user:", "");
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;
    try {
      const content = await this.plugin.app.vault.read(file);
      const ingredients: ParsedRecipe["ingredients"] = [];
      const tableSection = content.match(/##\s*🥩\s*食材清单[\s\S]*?(?=\n##\s|$)/);
      if (tableSection) {
        const rows = tableSection[0].split("\n").filter(l => l.includes("|") && l.includes("**"));
        for (const row of rows) {
          const cells = row.split("|").map(c => c.trim()).filter(Boolean);
          if (cells.length >= 2) {
            const ingName = cells[0]!.replace(/\*\*/g, "");
            const gramMatch = cells[1]!.match(/(\d+)\s*g/);
            const grams = gramMatch ? parseInt(gramMatch[1]!, 10) : 0;
            if (ingName && grams > 0) ingredients.push({ name: ingName, amountGrams: grams, isCore: grams >= 20 });
          }
        }
      }
      return { id: recipeId, name: filePath.split("/").pop()?.replace(/^食谱-/, "").replace(".md", "") || "", category: "user", categoryLabel: "我的食谱", difficulty: 1, caloriesPerServe: 0, ingredients, stepsPreview: "" };
    } catch { return null; }
  }

  // 零热量/极低热量辅料黑名单：这些食材重量大但几乎不含卡路里，
  // 在比例推算时必须排除，否则会严重稀释真实热量食材的占比
  private static readonly ZERO_CALORIE_AUXILIARY = new Set([
    "水", "清水", "开水", "饮用水", "高汤", "清汤", "骨汤", "冰", "冰块",
    "盐", "食盐", "食用盐", "酱油", "生抽", "老抽", "醋", "陈醋", "白醋",
    "料酒", "黄酒", " cooking wine",
    "葱", "大葱", "小葱", "香葱", "姜", "生姜", "蒜", "大蒜", "蒜瓣",
    "辣椒", "干辣椒", "花椒", "胡椒", "八角", "桂皮", "香叶",
    "味精", "鸡精", "糖", "白糖", "冰糖",
  ]);

  private _proportionalEstimate(entry: MealReplacement, recipe?: ParsedRecipe): number {
    if (!recipe || !entry.actualQuantities) return entry.baseCalories;
    // 过滤核心食材 + 排除零热量辅料黑名单
    const coreIngs = recipe.ingredients.filter(i => {
      if (!i.isCore) return false;
      const name = i.name;
      // 检查是否在零热量黑名单中
      for (const aux of CheatDayManager.ZERO_CALORIE_AUXILIARY) {
        if (name.includes(aux) || aux.includes(name)) return false;
      }
      return true;
    });
    const targetIngs = coreIngs.length > 0 ? coreIngs : recipe.ingredients.filter(i => {
      const name = i.name;
      for (const aux of CheatDayManager.ZERO_CALORIE_AUXILIARY) {
        if (name.includes(aux) || aux.includes(name)) return false;
      }
      return true;
    });
    const totalActual = targetIngs.reduce((sum, i) => sum + (entry.actualQuantities?.[i.name] ?? i.amountGrams), 0);
    const totalOrig = targetIngs.reduce((sum, i) => sum + i.amountGrams, 0);
    if (totalOrig <= 0) return entry.baseCalories;
    return Math.round(entry.baseCalories * (totalActual / totalOrig));
  }

  /** 计算某日总热量：AI 餐 + 替换餐 */
  getDayTotalCalories(date: string, aiMealCalories?: Partial<Record<MealSlot, number>>): { total: number } {
    const replacements = this.getReplacements(date);
    let total = 0;
    for (const slot of ["早餐", "午餐", "晚餐", "加餐"] as MealSlot[]) {
      const repl = replacements[slot];
      if (repl) {
        total += repl.adjustedCalories ?? repl.baseCalories ?? 0;
      } else if (aiMealCalories?.[slot]) {
        total += aiMealCalories[slot]!;
      }
    }
    return { total };
  }

  /** 检查某日是否有任何替换 */
  hasReplacements(date: string): boolean {
    const mr = this.plugin.settings.mealReplacements?.[date];
    return !!mr && Object.keys(mr).length > 0;
  }
}
