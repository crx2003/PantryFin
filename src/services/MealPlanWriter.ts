// src/services/MealPlanWriter.ts

import { App, TFile, TFolder, Notice } from "obsidian";
import { AgyResponse, SingleMealResponse, ConsumeItem } from "../models/types";

export class MealPlanWriter {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** 日期 → 年月日三层路径: 2026-06-30 → 2026/06/30 */
  static datePath(date: string): string {
    const p = date.split("-");
    return `${p[0]}/${p[1]}/${p[2]}`;
  }

  /**
   * 将 AI 生成的菜单写入 Vault。
   *
   * 写入路径规则：{mealPlanFolder}/{YYYY-MM-DD}.md
   * - 若文件已存在，追加"重新生成"分隔线后覆盖
   * - 若目录不存在，自动创建
   *
   * @param mealPlanFolder - 菜单存放目录（如 "Diet/Meal_Plans"）
   * @param date           - 日期字符串（如 "2026-06-26"）
   * @param response       - AI 结构化响应
   */
  async writeDailyPlan(
    mealPlanFolder: string,
    date: string,
    response: AgyResponse
  ): Promise<TFile> {
    // 1. 确保目录存在
    await this.ensureFolder(mealPlanFolder);

    // 2. 组装文件路径
    const filePath = `${mealPlanFolder}/${MealPlanWriter.datePath(date)}.md`;

    // 3. 构建完整的笔记内容（含 YAML Frontmatter）
    const noteContent = this.buildNoteContent(date, response);

    // 4. 创建或覆盖文件
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    let file: TFile;

    if (existingFile instanceof TFile) {
      // 文件已存在，覆盖内容
      await this.app.vault.modify(existingFile, noteContent);
      file = existingFile;
      new Notice(`🔄 PantryFin: 已更新 ${date} 饮食计划`);
    } else {
      // 创建新文件
      file = await this.app.vault.create(filePath, noteContent);
      new Notice(`✅ PantryFin: 已生成 ${date} 饮食计划`);
    }

    return file;
  }

  /**
   * 检查某天的菜单是否已经生成。
   */
  hasPlanForDate(mealPlanFolder: string, date: string): boolean {
    const filePath = `${mealPlanFolder}/${MealPlanWriter.datePath(date)}.md`;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile;
  }

  // ── 内部方法 ───────────────────────────────────────────

  private buildNoteContent(date: string, response: AgyResponse): string {
    // 构建 Frontmatter
    const frontmatter = [
      "---",
      `type: meal-plan`,
      `date: ${date}`,
      `generated_at: ${new Date().toISOString()}`,
      `tags:`,
      `  - pantryfin`,
      `  - meal-plan`,
      "---",
    ].join("\n");

    // 构建库存扣减摘要区块
    const consumeSummary = this.buildConsumeSummary(response);

    // 组合完整笔记
    return [
      frontmatter,
      "",
      response.markdownContent,
      "",
      consumeSummary,
    ].join("\n");
  }

  private buildConsumeSummary(response: AgyResponse): string {
    const lines: string[] = [
      "---",
      "",
      "## 📦 库存变动记录",
      "",
    ];

    if (response.consume.length > 0) {
      lines.push("### 今日消耗");
      lines.push("| 食材 | 消耗量 |");
      lines.push("| :--- | :--- |");
      for (const item of response.consume) {
        lines.push(`| ${item.name} | ${item.amount_g}g |`);
      }
      lines.push("");
    }

    if (response.shopping_advice.length > 0) {
      lines.push("### 🛒 采购建议");
      for (const advice of response.shopping_advice) {
        lines.push(
          `- [ ] ${advice} #shopping 📅 ${this.getNextDay()}`
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * 确保指定的文件夹路径存在，支持多级嵌套创建。
   */
  private async ensureFolder(folderPath: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) return; // 已存在

    // 逐级创建目录
    const parts = folderPath.split("/");
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.app.vault.getAbstractFileByPath(currentPath);
      if (!(folder instanceof TFolder)) {
        await this.app.vault.createFolder(currentPath);
      }
    }
  }

  private getNextDay(): string {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
  }

  // ══════════════════════════════════════════════════════
  //  v4.2 一餐一文件架构
  // ══════════════════════════════════════════════════════

  /** 英文文件名映射，避免文件系统编码问题 */
  private static readonly SLOT_FILENAME: Record<string, string> = {
    "早餐": "breakfast", "午餐": "lunch", "晚餐": "dinner", "加餐": "snack",
  };

  /** emoji 映射 */
  private static readonly SLOT_ICON: Record<string, string> = {
    "早餐": "🌅", "午餐": "☀️", "晚餐": "🌙", "加餐": "🍪",
  };

  /**
   * 确保日期子目录存在：{mealPlanFolder}/{date}/
   */
  async ensureDateSubfolder(mealPlanFolder: string, date: string): Promise<string> {
    const dateFolderPath = `${mealPlanFolder}/${MealPlanWriter.datePath(date)}`;
    await this.ensureFolder(dateFolderPath);
    return dateFolderPath;
  }

  /**
   * 将单餐 AI 响应写入独立文件。
   * 路径：{mealPlanFolder}/{date}/{slot_filename}.md
   */
  async writeSingleMeal(
    mealPlanFolder: string,
    date: string,
    mealSlot: string,
    response: SingleMealResponse
  ): Promise<TFile> {
    await this.ensureDateSubfolder(mealPlanFolder, date);

    const filename = MealPlanWriter.SLOT_FILENAME[mealSlot] || mealSlot;
    const filePath = `${mealPlanFolder}/${MealPlanWriter.datePath(date)}/${filename}.md`;

    // 从 markdownContent 中解析热量和宏量素（尽力而为）
    const calMatch = response.markdownContent.match(/预计\s*(\d+)\s*kcal/);
    const calories = calMatch ? parseInt(calMatch[1]!, 10) : 0;

    const icon = MealPlanWriter.SLOT_ICON[mealSlot] || "🍳";

    const frontmatter = [
      "---",
      `type: meal`,
      `meal_slot: ${mealSlot}`,
      `date: ${date}`,
      `generated_at: ${new Date().toISOString()}`,
      `calories: ${calories}`,
      `protein_g: 0`,
      `carbs_g: 0`,
      `fat_g: 0`,
      `image: ""`,
      `description: ""`,
      `tips: []`,
      `source: pantryfin`,
      `tags:`,
      `  - pantryfin`,
      `  - meal`,
      `  - ${mealSlot}`,
      "---",
    ].join("\n");

    const content = [
      frontmatter,
      "",
      `# ${icon} ${mealSlot} (预计 ${calories} kcal)`,
      "",
      response.markdownContent.replace(/^##\s*[^\n]*\n?/m, ""), // 去掉 AI 可能加的二级标题
    ].join("\n");

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
      return existingFile;
    }
    return this.app.vault.create(filePath, content);
  }

  /**
   * 写入/更新日索引文件。
   * 路径：{mealPlanFolder}/{date}.md（与旧版路径一致，兼容 hasPlanForDate()）
   */
  async writeDailyIndex(
    mealPlanFolder: string,
    date: string,
    meals: Array<{ slot: string; calories: number; consume: ConsumeItem[] }>,
    macroInfo: { targetCalories: number; protein_g: number; carbs_g: number; fat_g: number },
    allConsume: ConsumeItem[]
  ): Promise<TFile> {
    await this.ensureFolder(mealPlanFolder);

    const filePath = `${mealPlanFolder}/${MealPlanWriter.datePath(date)}.md`;
    const generatedSlots = meals.map(m => m.slot);

    const frontmatter = [
      "---",
      `type: meal-plan`,
      `date: ${date}`,
      `generated_at: ${new Date().toISOString()}`,
      `target_calories: ${macroInfo.targetCalories}`,
      `protein_g: ${macroInfo.protein_g}`,
      `carbs_g: ${macroInfo.carbs_g}`,
      `fat_g: ${macroInfo.fat_g}`,
      `generated_slots:`,
      ...generatedSlots.map(s => `  - ${s}`),
      `tags:`,
      `  - pantryfin`,
      `  - meal-plan`,
      "---",
    ].join("\n");

    // ── 餐次链接区 ──
    const mealLinks = meals.map(m => {
      const filename = MealPlanWriter.SLOT_FILENAME[m.slot] || m.slot;
      const icon = MealPlanWriter.SLOT_ICON[m.slot] || "🍳";
      const linkPath = `${MealPlanWriter.datePath(date)}/${filename}`;
      return `## ${icon} [[${linkPath}|${m.slot}]] (${m.calories} kcal)`;
    }).join("\n\n");

    // ── 消耗摘要 ──
    const consumeLines: string[] = [];
    if (allConsume.length > 0) {
      consumeLines.push("", "---", "", "## 📦 库存变动记录", "", "### 今日消耗");
      consumeLines.push("| 食材 | 消耗量 |");
      consumeLines.push("| :--- | :--- |");
      for (const item of allConsume) {
        consumeLines.push(`| ${item.name} | ${item.amount_g}g |`);
      }
    }

    const content = [
      frontmatter,
      "",
      `# 🍽️ ${date} 饮食计划`,
      "",
      `> 🎯 目标热量: **${macroInfo.targetCalories} kcal** | 蛋白质: **${macroInfo.protein_g}g** | 碳水: **${macroInfo.carbs_g}g** | 脂肪: **${macroInfo.fat_g}g**`,
      "",
      mealLinks,
      ...consumeLines,
    ].join("\n");

    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
      return existingFile;
    }
    return this.app.vault.create(filePath, content);
  }

  /**
   * 获取单餐文件的预期路径。
   */
  getSingleMealPath(mealPlanFolder: string, date: string, mealSlot: string): string {
    const filename = MealPlanWriter.SLOT_FILENAME[mealSlot] || mealSlot;
    return `${mealPlanFolder}/${MealPlanWriter.datePath(date)}/${filename}.md`;
  }
}
