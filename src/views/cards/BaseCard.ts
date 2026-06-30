import { App } from "obsidian";
import type NutriAgentPlugin from "../../main";
import { MealPlanParser } from "../../services/MealPlanParser";

export interface ICardContext {
  app: App;
  plugin: NutriAgentPlugin;
  settings: any;
  todayKey(date?: Date): string;
  getAgyEngine(): any;
  getPantryParser(): any;
  pantryParser: any;
  cheatDayManager?: any;
  recipeLibrary?: any;
  generateDailyPlan(date?: string): Promise<void>;
  acceptMealPlanAndDeduct(dateStr: string, mealLabel?: string): Promise<void>;
  revertMealPlanDeduction(dateStr: string, mealLabel?: string): Promise<void>;
  handleDailyAgentCommand(userInput: string, onChunk?: (text: string) => void): Promise<string | null>;
  syncMasterCenterNote(): Promise<void>;
  openPath(path: string, sourcePath?: string): Promise<void>;
  openFolder(path: string): Promise<void>;
  findOpenTasks(limit?: number): Promise<any[]>;
  completeTask(task: any): Promise<void>;
  saveChatHistory(history: Record<string, Array<{ sender: string; text: string }>>): Promise<void>;
  scheduleRender(): void;
  forceRefresh(): Promise<void>;
  cachedTargetCal: number;
  dailyMessages: Array<{ sender: string; text: string }>;
  isDailyThinking: boolean;
  streamingReply: { text: string } | null;
  persistChatHistory(): void;
}

export abstract class BaseCard {
  constructor(protected container: HTMLElement, protected context: ICardContext) {}

  protected createCard(area: string, title: string, actionText: string, action?: () => void): HTMLElement {
    const card = this.container.createDiv({ cls: `museum-live-card area-${area}` });
    if (title || actionText) {
      const header = card.createDiv({ cls: "museum-live-card-header" });
      if (title) header.createEl("h3", { text: title });
      if (actionText) {
        const button = header.createEl("button", { text: actionText });
        if (action) button.addEventListener("click", action);
      }
    }
    return card;
  }

  public extractNutrition(content: string): {
    targetCalories: number;
    totalCalories: number;
    protein: number;
    proteinTarget: number;
    carbs: number;
    carbsTarget: number;
    fat: number;
    fatTarget: number;
  } {
    const defaults = {
      targetCalories: 0, totalCalories: 0,
      protein: 0, proteinTarget: 0,
      carbs: 0, carbsTarget: 0,
      fat: 0, fatTarget: 0,
    };

    const tdeeMatch = content.match(/目标热量[^:：]*[:：]\s*(\d+(?:\.\d+)?)\s*kcal/);
    if (tdeeMatch) defaults.targetCalories = parseInt(tdeeMatch[1]!, 10);

    const macroMatch = content.match(/蛋白质\s*(\d+)\s*g.*碳水\s*(\d+)\s*g.*脂肪\s*(\d+)\s*g/);
    if (macroMatch) {
      defaults.proteinTarget = parseInt(macroMatch[1]!, 10);
      defaults.carbsTarget = parseInt(macroMatch[2]!, 10);
      defaults.fatTarget = parseInt(macroMatch[3]!, 10);
    }

    const mealCalories = [...content.matchAll(/预计\s*(\d+(?:\.\d+)?)\s*kcal/g)];
    defaults.totalCalories = mealCalories.reduce((sum, m) => sum + parseInt(m[1]!, 10), 0);

    if (defaults.targetCalories > 0 && defaults.totalCalories > 0) {
      const ratio = defaults.totalCalories / defaults.targetCalories;
      defaults.protein = Math.round(defaults.proteinTarget * ratio);
      defaults.carbs = Math.round(defaults.carbsTarget * ratio);
      defaults.fat = Math.round(defaults.fatTarget * ratio);
    }

    return defaults;
  }

  public extractMeals(content: string): Array<{
    label: string;
    description: string;
    calories: number;
    ingredients: string;
  }> {
    const meals: Array<{ label: string; description: string; calories: number; ingredients: string }> = [];
    const MEAL_NAMES = ["早餐", "午餐", "晚餐", "加餐", "早午餐", "夜宵"];

    const headerRegex = /##\s*(?:[🍳🥗🌙🍵☀️🌅🌃🍪🥐]*\s*)?(早餐|午餐|晚餐|加餐|早午餐|夜宵)/g;
    const headerMatches: Array<{ label: string; index: number; endIndex: number }> = [];
    let hm: RegExpExecArray | null;
    while ((hm = headerRegex.exec(content)) !== null) {
      headerMatches.push({ label: hm[1]!, index: hm.index, endIndex: hm.index + hm[0].length });
    }

    if (headerMatches.length === 0) {
      const boldRegex = /\*\*(早餐|午餐|晚餐|加餐|早午餐|夜宵)\*\*/g;
      let bm: RegExpExecArray | null;
      while ((bm = boldRegex.exec(content)) !== null) {
        headerMatches.push({ label: bm[1]!, index: bm.index, endIndex: bm.index + bm[0].length });
      }
    }

    if (headerMatches.length === 0) {
      // 废弃 indexOf 盲查，改用严格的正文标题正则（永不匹配 Frontmatter/前言）
      const strictRegex = /^#{2,4}\s*(?:[🍳🥗🌙🍵☀️🌅🌃🍪🥐]*\s*)?(早餐|午餐|晚餐|加餐|早午餐|夜宵)/gm;
      let sm: RegExpExecArray | null;
      while ((sm = strictRegex.exec(content)) !== null) {
        headerMatches.push({ label: sm[1]!, index: sm.index, endIndex: sm.index + sm[0].length });
      }
    }

    for (let i = 0; i < headerMatches.length; i++) {
      const current = headerMatches[i]!;
      let nextIndex = i < headerMatches.length - 1 ? headerMatches[i + 1]!.index : content.length;
      let sectionText = content.substring(current.endIndex, nextIndex).trim();

      // 最后一道菜：在 ## 💡 或 --- 处截断，防止采购建议/JSON混入步骤
      if (i === headerMatches.length - 1) {
        const cutAt = sectionText.search(/\n##\s+💡|\n---/);
        if (cutAt > 0) sectionText = sectionText.substring(0, cutAt).trim();
      }

      const calMatch = sectionText.match(/预计\s*(\d+(?:\.\d+)?)\s*kcal/) ||
                       content.substring(current.index, current.endIndex + 30).match(/(\d+(?:\.\d+)?)\s*kcal/);
      const calories = calMatch ? parseInt(calMatch[1]!, 10) : 0;

      // 扩展同义词：用料/食材/原料/配料/准备原料/精确食材 等 AI 可能输出的变体
      const ingRegex = /[-*•]\s*\*\*(?:精确)?(?:原料|食材|用料|配料|准备原料|精确食材)(?:清单)?\*\*\s*[：:]\s*([^\n]+)/;
      const ingRegexPlain = /[-*•]\s*(?:精确)?(?:原料|食材|用料|配料|准备原料|精确食材)(?:清单)?[：:]\s*([^\n]+)/;
      const ingMatch = sectionText.match(ingRegex) || sectionText.match(ingRegexPlain);
      const ingredients = ingMatch ? ingMatch[1]!.trim() : "";

      // 白名单捕获：优先匹配编号步骤行 (1. / 1、 / 1) / 第一步)，无编号时降级取全部非元数据行
      const allLines = sectionText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      const stepLines = allLines.filter(l => /^\d+[\.\/、)]/.test(l) || /^第[一二三四五六七八九十]步/.test(l));
      const metaPrefixes = ["- **程序化", "- **操作步骤", "- **菜品名称", "- **精确原料", "- **烹饪时间", "- **营养"];
      const descLines = stepLines.length >= 2
        ? stepLines  // 有 ≥2 条编号步骤 → 只用编号行
        : allLines.filter(l => !l.startsWith("#") && !metaPrefixes.some(p => l.startsWith(p)));
      const description = descLines.join("\n");

      meals.push({ label: current.label, description, calories, ingredients });
    }

    return meals;
  }

  /**
   * v4.2 从日索引内容中解析餐次文件链接。
   * 日索引格式：## 🌅 [[2026-06-29/breakfast|早餐]] (450 kcal)
   * @returns 餐次文件描述符数组
   */
  public extractMealsFromIndex(indexContent: string): Array<{
    label: string;
    filePath: string;
    calories: number;
  }> {
    return MealPlanParser.parseIndexMeals(indexContent);
  }

  abstract render(): void | Promise<void>;
}
