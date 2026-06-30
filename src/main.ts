// src/main.ts — PantryFin v1.0.0

import { Plugin, Notice, TFile, normalizePath, Platform } from "obsidian";
import { ProfileParser } from "./services/ProfileParser";
import { PantryParser } from "./services/PantryParser";
import { AgyEngine } from "./services/AgyEngine";
import { MealPlanWriter } from "./services/MealPlanWriter";
import { MemoryManager } from "./services/MemoryManager";
import { RuleManager } from "./services/RuleManager";
import { LocalMathEngine } from "./services/LocalMathEngine";
import { CronScheduler } from "./scheduler/CronScheduler";
import { NutriAgentSettingTab } from "./settings";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./views/DashboardView";
import { HtmlReaderView, VIEW_TYPE_HTML_READER } from "./views/HtmlReaderView";
import { RecipePickerModal } from "./views/RecipePickerModal";
import { MenuCalculator } from "./nutrition/menu-calculator";
import { FoodDataLoader } from "./nutrition/fooddata-loader";
import { SubagentRegistry, createDefaultRegistry } from "./services/SubagentRegistry";
import { ContextPackager } from "./services/ContextPackager";
import { OutputVerifier } from "./services/OutputVerifier";
import { migrateSettings } from "./settings/migrate-settings";
import { log_error, log_warn, log_info } from "./utils/Log";
import { errorWrapper } from "./utils/Error";
import { createAPI, NutriAgentAPI } from "./api";
import type { PantryItem } from "./models/types";
import { RecipeLibrary } from "./services/RecipeLibrary";
import { CheatDayManager } from "./services/CheatDayManager";
import { BackupManager } from "./services/BackupManager";
import { IngredientValidator } from "./services/IngredientValidator";
import { AutomationEngine, type AutomationRule } from "./services/AutomationEngine";
import { RecipeScraper } from "./services/RecipeScraper";
import { RichRecipeScraper } from "./services/RichRecipeScraper";
import { HtmlArchiver } from "./services/HtmlArchiver";
import { getFoodDatabase, rebuildFoodDatabase } from "./nutrition/FoodDatabase";
import { getFDCFoods } from "./nutrition/fdc-data";
import { toBase, fromBase, parseQuantity } from "./utils/units";

interface TaskHit {
  file: TFile;
  line: number;
  text: string;
  done: boolean;
}

interface TodayTaskStats {
  total: number;
  open: number;
  tasks: TaskHit[];
}

// ── 设置接口 ─────────────────────────────────────────────
export interface NutriAgentSettings {
  profilePath: string;
  pantryPath: string;
  mealPlanFolder: string;
  agyCLIPath: string;
  agyModel: string;
  agyTimeoutSeconds: number;
  aiProviderMode?: 'api' | 'cli';
  apiBaseUrl?: string;
  apiKey?: string;
  apiModel?: string;
  scheduledTime: string;
  autoGenerate: boolean;
  acceptedMealTicks: Record<string, string[]>;
  installDate?: string;
  /** AI 管家聊天记录持久化: { "2026-06-27": [{sender, text}, ...] } */
  chatHistory?: Record<string, Array<{ sender: string; text: string }>>;
  /** 上次扣减记录，供 revert 精确恢复: { "2026-06-27_早餐": [{name, amount_g}] } */
  lastDeduction?: Record<string, Array<{ name: string; amount_g: number }>>;
  /** Yori 风格: 卡片显隐开关 */
  showCard?: Record<string, boolean>;
  /** 消耗日志: { "鸡胸肉": [{date:"2026-06-27", amount_g:150}, ...] } */
  consumptionLog?: Record<string, Array<{ date: string; amount_g: number }>>;
  /** 食谱缺料清单: { "2026-06-27": ["西兰花", "牛肉"] } */
  missingIngredients?: Record<string, string[]>;
  /** 购物任务: { "2026-06-27": ["采购西兰花（今日食谱需要）", ...] } — 直接渲染到待办卡片 */
  shoppingTasks?: Record<string, string[]>;
  /** Templater 风格: 设置版本号，用于迁移 */
  data_version?: number;
  /** 餐次替换: { "2026-06-28": { "午餐": { recipeId, recipeName, baseCalories, ... } } } */
  mealReplacements?: import("./models/types").MealReplacements;
  /** 用户自定义食材别名: { "三层肉": "五花肉", "蕃茄": "番茄" } */
  foodAliases?: Record<string, string>;
  /** 自动化预处理规则 */
  automationRules?: AutomationRule[];
  /** 智能就近回退天数配置 */
  fallbackDays?: number;
}

const DEFAULT_SETTINGS: NutriAgentSettings = {
  profilePath: "Diet/Profile.md",
  pantryPath: "Diet/Pantry.md",
  mealPlanFolder: "Diet/Meal_Plans",
  agyCLIPath: "",
  agyModel: "",                // 空字符串表示使用 agy 默认模型
  agyTimeoutSeconds: 300,      // 5 分钟
  aiProviderMode: 'api',
  apiBaseUrl: 'https://api.deepseek.com',
  apiKey: '',
  apiModel: 'deepseek-v4-flash',
  scheduledTime: "06:30",
  autoGenerate: true,
  acceptedMealTicks: {},
  showCard: { chat: true, diet: true, pantry: true, tasks: true, tracker: true },
  fallbackDays: 3,
};

// ── 插件主类 ─────────────────────────────────────────────
export default class NutriAgentPlugin extends Plugin {
  settings: NutriAgentSettings = DEFAULT_SETTINGS;

  private profileParser!: ProfileParser;
  public pantryParser!: PantryParser;
  private agyEngine!: AgyEngine;
  private mealPlanWriter!: MealPlanWriter;
  private memoryManager!: MemoryManager;
  private ruleManager!: RuleManager;
  private localMathEngine!: LocalMathEngine;
  private scheduler!: CronScheduler;
  public menuCalculator!: MenuCalculator;
  public foodDataLoader!: FoodDataLoader;
  public subagentRegistry!: SubagentRegistry;
  public contextPackager!: ContextPackager;
  public outputVerifier!: OutputVerifier;
  public api!: NutriAgentAPI;
  public backupManager!: BackupManager;
  public ingredientValidator!: IngredientValidator;
  public automationEngine!: AutomationEngine;
  public recipeScraper!: RecipeScraper;
  public richRecipeScraper!: RichRecipeScraper;
  public htmlArchiver!: HtmlArchiver;

  public recipeLibrary!: RecipeLibrary;
  public cheatDayManager!: CheatDayManager;
  private _aiPending = 0;
  private _syncLock = false;  // 同步锁，防止 syncMasterCenterNote 并发写冲突

  async onload(): Promise<void> {
    console.log("PantryFin: Loading plugin...");
    if (Platform.isMobile) document.body.classList.add("is-mobile");

    // 逐步骤 try-catch，确保任何一个步骤失败都不会阻止插件启用
    try { await this.loadSettings(); } catch (e) { console.error("PantryFin: loadSettings failed", e); }

    try { this.initServices(); this.api = createAPI(this); } catch (e) { console.error("PantryFin: initServices failed", e); }

    // 预热 FoodDatabase: 先构建基础索引，再异步加载 FDC 后重建完整索引
    try {
      getFoodDatabase(); // 立即构建 (china-foods + USDA mini 基础索引)
      this.foodDataLoader?.getFoods().then(() => {
        const fdc = getFDCFoods();
        if (fdc && fdc.length > 0) {
          rebuildFoodDatabase(fdc);
        }
      }).catch(() => {});
    } catch (e) { console.warn("[PantryFin] FoodDatabase warmup:", e); }

    try { this.addRibbonIcon("salad", "PantryFin", async () => { await this.handleRibbonClick(); }); } catch (e) { console.error("PantryFin: ribbon failed", e); }

    try {
      this.addCommand({ id: "generate-daily-plan", name: "立即生成今日饮食计划", callback: async () => await this.generateDailyPlan() });
      this.addCommand({ id: "generate-tomorrow-plan", name: "生成明日饮食计划", callback: async () => { const t = new Date(); t.setDate(t.getDate()+1); await this.generateDailyPlan(this.todayKey(t)); } });
      this.addCommand({ id: "open-dashboard", name: "打开 PantryFin 仪表盘", callback: async () => { await this.activateDashboard(); } });
      this.addCommand({ id: "open-cheat-day", name: "打开放纵日自选餐", callback: async () => { const today = this.todayKey(); new RecipePickerModal(this.app, this, today).open(); } });
      this.addCommand({ id: "import-recipe-url", name: "从网页导入食谱", callback: async () => { await this.importRecipeFromUrl(); } });
    } catch (e) { console.error("PantryFin: commands failed", e); }

    try {
      const sb = this.addStatusBarItem();
      const st = sb.createEl("span", { text: "🐟 PantryFin", attr: { style: "cursor:pointer;" } });
      st.addEventListener("click", async () => { await this.activateDashboard(); });
      st.addEventListener("touchend", async (ev) => { ev.preventDefault(); await this.activateDashboard(); });
    } catch (e) { console.error("PantryFin: statusBar failed", e); }

    try { this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this)); } catch (e) { console.error("PantryFin: registerView failed", e); }
    try { this.registerView(VIEW_TYPE_HTML_READER, (leaf) => new HtmlReaderView(leaf)); } catch (e) { console.error("PantryFin: registerView html-reader failed", e); }

    try { this.initScheduler(); } catch (e) { console.error("PantryFin: scheduler failed", e); }

    try { this.addSettingTab(new NutriAgentSettingTab(this.app, this)); } catch (e) { console.error("PantryFin: settingsTab failed", e); }

    try {
      this.registerDomEvent(document, "click", (evt: MouseEvent) => {
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        const a = target.closest("a") as HTMLAnchorElement | null;
        if (!a) return;
        const href = a.getAttribute("href") || a.getAttribute("data-href") || "";
        if ((href.includes("Recipe_Assets/") || href.includes("index.html")) && href.endsWith(".html")) {
          evt.preventDefault();
          evt.stopPropagation();
          let relPath = href.replace(/^[a-z]+:\/\/[^/]+\//, "");
          if (relPath.startsWith("/")) relPath = relPath.substring(1);
          const file = this.app.vault.getAbstractFileByPath(decodeURIComponent(relPath)) || this.app.vault.getAbstractFileByPath(relPath);
          if (!(file instanceof TFile)) return;

          // Cmd/Ctrl+Click → 系统浏览器
          if (evt.metaKey || evt.ctrlKey) {
            if (typeof (this.app as any).openWithDefaultApp === "function") {
              (this.app as any).openWithDefaultApp(file.path);
              return;
            }
          }

          // 默认: Obsidian 内部 HTML 阅读器
          this._openHtmlInReader(file);
        }
      }, true);
    } catch (e) { console.error("PantryFin: html click interceptor failed", e); }

    console.log("PantryFin: Plugin loaded successfully.");
    new Notice("🐟 PantryFin 已就绪！");
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_DASHBOARD);
    console.log("PantryFin: Plugin unloaded.");
  }

  // ══════════════════════════════════════════════════════
  //  核心业务流程与新手引导流 (Onboarding)
  // ══════════════════════════════════════════════════════

  /**
   * 🎀 侧边栏图标点击总调度（含微信式AI聊天采访流）
   */
  async handleRibbonClick(): Promise<void> {
    const profilePath = this.settings.profilePath;
    const profileFile = this.app.vault.getAbstractFileByPath(profilePath);

    // ── 情景一：首次使用无档案，自动生成模板并打开供用户自填 ──
    if (!(profileFile instanceof TFile)) {
      await this.ensureTemplates();
      const newProfile = this.app.vault.getAbstractFileByPath(profilePath);
      if (newProfile instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(newProfile);
      }
      new Notice("📝 已生成初始营养档案！请填写身体数据后点击生成菜单。", 6000);
      return;
    }

    // ── 情景二：已有档案，展开面板并检查今日菜单 ──
    await this.activateDashboard();

    const today = this.todayKey();
    const hasPlan = this.mealPlanWriter.hasPlanForDate(this.settings.mealPlanFolder, today);

    if (!hasPlan) {
      new Notice(`🥗 档案检测通过！正在为您规划今日（${today}）饮食...`);
      await this.generateDailyPlan();
    } else {
      new Notice(`📊 Dashboard 仪表盘已展开！`);
    }
  }

  /** 自动创建 Profile.md 和 Pantry.md 初始模板（如果不存在） */
  async ensureTemplates(): Promise<void> {
    const vault = this.app.vault;

    // Profile.md
    const profilePath = this.settings.profilePath;
    if (!vault.getAbstractFileByPath(profilePath)) {
      const profileDir = profilePath.substring(0, profilePath.lastIndexOf("/"));
      if (profileDir && !vault.getAbstractFileByPath(profileDir)) {
        await vault.createFolder(profileDir);
      }
      const profileContent = `---
height_cm: 175
weight_kg: 70
age: 25
gender: male
activity_level: moderate
goal_type: fat_loss
target_weight_kg: 65
weekly_rate_kg: -0.5
allergies: []
dislikes: []
dietary_style: balanced
---
# 个人膳食设计档案

> 修改上方数字即可，AI 会自动识别。\n> gender: male 或 female\n> activity_level: sedentary / light / moderate / active / very_active\n> goal_type: fat_loss / muscle_gain / maintenance\n> dietary_style: balanced / low_carb / keto / mediterranean / high_protein
> 也可以点击左侧 🐟 图标，让 AI 营养师通过聊天帮你更新档案。
`;
      await vault.create(profilePath, profileContent);
    }

    // Pantry.md
    const pantryPath = this.settings.pantryPath;
    if (!vault.getAbstractFileByPath(pantryPath)) {
      const pantryDir = pantryPath.substring(0, pantryPath.lastIndexOf("/"));
      if (pantryDir && !vault.getAbstractFileByPath(pantryDir)) {
        await vault.createFolder(pantryDir);
      }
      const pantryContent = `# 🥬 食材库存清单

> PantryFin 会自动读取下表，并在生成菜单后建议扣减。
> 数量列为纯数字(base值)，单位列记录基准单位(g/ml/枚)。

| 食材类别 | 食材名称 | 数量 | 单位 | 采购日期 |
| :--- | :--- | :--- | :--- | :--- |
| 蛋白质 | 鸡胸肉 | 500 | g | ${this.todayKey()} |
| 蛋白质 | 鸡蛋 | 10 | 枚 | ${this.todayKey()} |
`;
      await vault.create(pantryPath, pantryContent);
    }
  }

  /**
   * 自动创建新手引导模板文件
   */


  // ── v4.2 单次 AI 调用 + 程序切分三文件 ─────────────────
  async generateDailyPlan(date?: string): Promise<void> {
    const targetDate = date ?? this.todayKey();

    new Notice(`🐟 PantryFin: 正在为 ${targetDate} 规划三餐...`);

    try {
      // Step 1: 读取用户身体档案
      const profile = await this.profileParser.readProfile(
        this.settings.profilePath
      );
      if (!profile) {
        new Notice("📝 未检测到个人档案，请先通过 Ribbon 图标创建模板", 5000);
        return;
      }

      // Step 2: 读取食材库存
      const pantry = await this.pantryParser.readPantry(
        this.settings.pantryPath
      );
      if (pantry.length === 0) {
        new Notice(
          `⚠️ ${this.settings.pantryPath} 中没有食材记录，AI 将无法规划菜单。`,
          8000
        );
      }

      // Step 3: 构建全日 Prompt + 一次 AI 调用（热量分布均匀）
      const memSlice = await this.memoryManager.getRecentMemorySlice(3);
      const rulesText = await this.ruleManager.getRules();
      const ctxPackage = await this.contextPackager.build(
        profile, pantry, targetDate, memSlice, rulesText,
        this.menuCalculator, this.foodDataLoader
      );
      const compactPrompt = this.contextPackager.buildCompactPrompt(ctxPackage);

      const response = await this.agyEngine.generateFromCompactPrompt(compactPrompt);
      if (!response) return;

      // Step 3.5: 验证 AI 输出
      const verifyReport = await this.outputVerifier.verify(response.consume, pantry);
      if (verifyReport.rejected.length > 0) {
        console.warn("[PantryFin] AI 输出验证拦截:", verifyReport.rejected);
        new Notice(`⚠️ AI 生成的 ${verifyReport.rejected.length} 项消耗指令未通过本地验证，已自动过滤`, 6000);
        response.consume = verifyReport.safe;
      }

      // Step 4: 程序切分全日 markdown → 三份单餐内容
      const mealSlots = ["早餐", "午餐", "晚餐"] as const;
      const splitMeals = this._splitFullDayContent(response.markdownContent);
      const generatedMeals: Array<{
        slot: string; calories: number; consume: Array<{ name: string; amount_g: number }>
      }> = [];

      for (const slot of mealSlots) {
        const section = splitMeals[slot];
        if (!section || section.trim().length < 20) {
          console.warn(`[PantryFin] 未能切分出${slot}区块`);
          continue;
        }

        // 将消耗项分配给该餐（按食材名在区块中出现）
        const mealConsume = response.consume.filter(c => section.includes(c.name));

        // 写单餐文件
        const calMatch = section.match(/预计\s*(\d+)\s*kcal/);
        const mealCalories = calMatch ? parseInt(calMatch[1]!, 10) : 0;

        await this.mealPlanWriter.writeSingleMeal(
          this.settings.mealPlanFolder,
          targetDate,
          slot,
          { markdownContent: section, consume: mealConsume }
        );

        generatedMeals.push({ slot, calories: mealCalories, consume: mealConsume });
        new Notice(`✅ ${slot}已切分写入 (${mealCalories} kcal)`, 2000);
      }

      if (generatedMeals.length === 0) {
        new Notice("❌ 三餐切分失败，请检查 AI 输出格式", 6000);
        return;
      }

      // Step 5: 写入日索引文件
      const macroInfo = {
        targetCalories: ctxPackage.computed.targetCalories,
        protein_g: ctxPackage.computed.macroTargets.protein_g,
        carbs_g: ctxPackage.computed.macroTargets.carbs_g,
        fat_g: ctxPackage.computed.macroTargets.fat_g,
      };
      const planFile = await this.mealPlanWriter.writeDailyIndex(
        this.settings.mealPlanFolder,
        targetDate,
        generatedMeals,
        macroInfo,
        response.consume
      );

      await this.memoryManager.appendMemory(`自动生成 ${targetDate} 饮食方案（一次AI调用→程序切分${generatedMeals.length}餐）。`);
      await this.syncMasterCenterNote();

      // Step 7: 刷新 Dashboard
      const dashboardLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
      for (const dLeaf of dashboardLeaves) {
        const view = dLeaf.view;
        if (view instanceof DashboardView) {
          await new Promise(r => setTimeout(r, 100));
          await view.forceRefresh();
        }
      }

      // Step 8: 打开日索引文件
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(planFile);

      new Notice(
        `✅ ${targetDate} 三餐规划完毕！(${generatedMeals.map(m => `${m.slot} ${m.calories}kcal`).join(" | ")})`,
        6000
      );
      this.api.hooks.trigger("planGenerated", { date: targetDate });
    } catch (err) {
      console.error("PantryFin: generateDailyPlan failed:", err);
      new Notice(
        `❌ PantryFin 生成失败: ${(err as Error).message}`,
        8000
      );
    }
  }

  /**
   * v4.2 程序切分 AI 全日 markdown → 按餐次提取独立区块。
   * AI 输出格式：## 🍳 早餐 (预计 xxx kcal) ... ## 🥗 午餐 ... ## 🌙 晚餐 ...
   * @returns { "早餐": markdown, "午餐": markdown, "晚餐": markdown }
   */
  private _splitFullDayContent(markdown: string): Record<string, string> {
    const result: Record<string, string> = { "早餐": "", "午餐": "", "晚餐": "" };
    if (!markdown) return result;

    const MEAL_PATTERNS: Array<{ slot: string; regex: RegExp }> = [
      { slot: "早餐", regex: /##\s*(?:[🍳🌅]*\s*)?早餐/ },
      { slot: "午餐", regex: /##\s*(?:[🥗☀️]*\s*)?午餐/ },
      { slot: "晚餐", regex: /##\s*(?:[🌙🌃]*\s*)?晚餐/ },
    ];

    // 找到各餐次标题位置
    const positions: Array<{ slot: string; index: number; length: number }> = [];
    for (const pat of MEAL_PATTERNS) {
      const m = markdown.match(pat.regex);
      if (m && m.index !== undefined) {
        positions.push({ slot: pat.slot, index: m.index, length: m[0].length });
      }
    }
    positions.sort((a, b) => a.index - b.index);

    // 按位置切分
    for (let i = 0; i < positions.length; i++) {
      const cur = positions[i]!;
      const startIdx = cur.index;  // 从 ## 标题开始
      const endIdx = i < positions.length - 1
        ? positions[i + 1]!.index
        : markdown.length;

      let section = markdown.substring(startIdx, endIdx).trim();

      // 在下一个 ## 标题或 --- 处截断（排除采购建议、JSON 块等尾部内容）
      if (i === positions.length - 1) {
        const trailingCut = section.search(/\n##\s*(?:[📦💡🛒]|库存|采购|小贴士|Tips?)/);
        if (trailingCut > 0) section = section.substring(0, trailingCut).trim();
        const hrCut = section.lastIndexOf("\n---");
        if (hrCut > 0) {
          // 检查 --- 后面是否有实质内容
          const afterHr = section.substring(hrCut).replace(/[-—\s]/g, "");
          if (afterHr.length < 10) section = section.substring(0, hrCut).trim();
        }
      }

      result[cur.slot] = section;
    }

    // 回退：如果某个餐次没匹配到，尝试用标签名直接搜索
    for (const slot of ["早餐", "午餐", "晚餐"]) {
      if (!result[slot] || result[slot]!.length < 20) {
        const fallbackMatch = markdown.match(new RegExp(
          `##\\s*[^\\n]*${slot}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`
        ));
        if (fallbackMatch) result[slot] = fallbackMatch[0]!.trim();
      }
    }

    return result;
  }

  /**
   * 用户打勾接受 AI 规划菜谱后，自动按菜谱扣除对应库存
   */
  /**
   * 智能同步：AI 扣减库存后，自动匹配今日食谱中的对应餐次并勾选。
   * 当消耗的食材出现在某餐次的食材清单中时，自动标记该餐次为已打卡。
   */
  /** v4.2 单餐重做：生成新单餐 → 直接覆盖单餐文件 → 更新日索引 */
  async reRollSingleMeal(dateStr: string, targetMeal: string): Promise<void> {
    // 检查单餐文件是否存在
    const mealPath = this.mealPlanWriter.getSingleMealPath(
      this.settings.mealPlanFolder, dateStr, targetMeal
    );
    const mealFile = this.app.vault.getAbstractFileByPath(mealPath);
    if (!(mealFile instanceof TFile)) {
      new Notice(`⚠️ 尚未生成${targetMeal}，请先生成全天计划`);
      return;
    }

    const pantry = await this.pantryParser.readPantry(this.settings.pantryPath);
    const profile = await this.profileParser.readProfile(this.settings.profilePath);
    if (!profile) { new Notice("请先创建身体档案"); return; }

    // 读取日索引，获取其他已生成餐次信息
    const indexPath = `${this.settings.mealPlanFolder}/${MealPlanWriter.datePath(dateStr)}.md`;
    const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
    const alreadyGenerated: Array<{ slot: string; calories: number; mainIngredients: string[] }> = [];

    if (indexFile instanceof TFile) {
      try {
        const idxContent = await this.app.vault.read(indexFile);
        // 从日索引中解析其他餐次的热量信息
        for (const slot of ["早餐", "午餐", "晚餐"]) {
          if (slot === targetMeal) continue;
          const linkRegex = new RegExp(`\\\\[\\\\[.*?\\\\|${slot}\\\\]\\\\].*?\\((\\\\d+)\\\\s*kcal\\\\)`, "i");
          const m = idxContent.match(linkRegex);
          if (m) {
            // 读取该餐文件的消耗信息
            const otherPath = this.mealPlanWriter.getSingleMealPath(
              this.settings.mealPlanFolder, dateStr, slot
            );
            const otherFile = this.app.vault.getAbstractFileByPath(otherPath);
            if (otherFile instanceof TFile) {
              const otherContent = await this.app.vault.read(otherFile);
              const calMatch = otherContent.match(/calories:\\s*(\\d+)/);
              const cals = calMatch ? parseInt(calMatch[1]!, 10) : 0;
              // 从 frontmatter 或内容中提取主料
              const ingMatch = otherContent.match(/##\\s*🥩\\s*食材清单[\\s\\S]*?(?=\\n##\\s|$)/);
              const mainIngs: string[] = [];
              if (ingMatch) {
                const boldMatches = ingMatch[0].matchAll(/\\*\\*([^*]+)\\*\\*/g);
                for (const bm of boldMatches) {
                  if (bm[1]) mainIngs.push(bm[1]!);
                  if (mainIngs.length >= 3) break;
                }
              }
              alreadyGenerated.push({ slot, calories: cals, mainIngredients: mainIngs });
            }
          }
        }
      } catch {}
    }

    const ctxPackage = await this.contextPackager.build(
      profile, pantry, dateStr, "", ""
    );
    const mealPrompt = this.contextPackager.buildMealPrompt(
      ctxPackage, targetMeal, alreadyGenerated
    );

    new Notice(`🔄 正在重做${targetMeal}...`);
    const response = await this.agyEngine.generateSingleMeal(mealPrompt);
    if (!response) { new Notice("❌ 重做失败"); return; }

    // 验证 AI 输出
    const verifyReport = await this.outputVerifier.verify(response.consume, pantry);
    if (verifyReport.rejected.length > 0) {
      response.consume = verifyReport.safe;
    }

    // 直接覆盖单餐文件（不再需要全文正则替换！）
    await this.mealPlanWriter.writeSingleMeal(
      this.settings.mealPlanFolder,
      dateStr,
      targetMeal,
      response
    );

    // 更新日索引中的热量数据
    if (indexFile instanceof TFile) {
      try {
        let idxContent = await this.app.vault.read(indexFile);
        const calMatch = response.markdownContent.match(/预计\s*(\d+)\s*kcal/);
        const newCals = calMatch ? parseInt(calMatch[1]!, 10) : 0;
        // 更新日索引中对应餐次的热量标注
        const calUpdateRegex = new RegExp(
          `(\\\\[\\\\[.*?\\\\|${targetMeal}\\\\]\\\\]\\\\s*\\\\().*?(\\\\s*kcal\\\\))`, "i"
        );
        if (calUpdateRegex.test(idxContent)) {
          idxContent = idxContent.replace(calUpdateRegex, `$1${newCals}$2`);
          await this.app.vault.modify(indexFile, idxContent);
        }
      } catch {}
    }

    new Notice(`✨ ${targetMeal}已更新`);
    this.api.hooks.trigger("planGenerated", { date: dateStr });
  }

  /** 清冰箱日：扫描尾货（≤250g 或 ≤2个），生成创意清零食谱 */

  private async _syncMealTicksFromConsume(consumed: Array<{ name: string; amount_g: number }>): Promise<void> {
    try {
      const today = this.todayKey();
      const planPath = `${this.settings.mealPlanFolder}/${MealPlanWriter.datePath(today)}.md`;
      const planFile = this.app.vault.getAbstractFileByPath(planPath);
      if (!(planFile instanceof TFile)) return;

      const content = await this.app.vault.read(planFile);
      const isNewFormat = /generated_slots:/.test(content);

      this.settings.acceptedMealTicks = this.settings.acceptedMealTicks || {};
      const todayTicks = this.settings.acceptedMealTicks[today] || [];
      let matchedMeals: string[] = [];

      if (isNewFormat) {
        // v4.2: 读取每餐独立文件
        for (const slot of ["早餐", "午餐", "晚餐"] as const) {
          if (todayTicks.includes(slot)) continue;
          const mealPath = this.mealPlanWriter.getSingleMealPath(
            this.settings.mealPlanFolder, today, slot
          );
          const mealFile = this.app.vault.getAbstractFileByPath(mealPath);
          if (!(mealFile instanceof TFile)) continue;
          const mealContent = await this.app.vault.read(mealFile);
          const matched = consumed.some(c => mealContent.includes(c.name));
          if (matched) matchedMeals.push(slot);
        }
      } else {
        // 旧格式：按 ## 标题切分
        const mealSections = content.split(/\n##\s+/);
        for (const section of mealSections) {
          const mealMatch = section.match(/^(早餐|午餐|晚餐|加餐|早午餐|夜宵)/);
          if (!mealMatch || !mealMatch[1]) continue;
          const mealLabel = mealMatch[1];
          if (todayTicks.includes(mealLabel)) continue;
          const matched = consumed.some(c => section.includes(c.name));
          if (matched) matchedMeals.push(mealLabel);
        }
      }

      if (matchedMeals.length > 0) {
        this.settings.acceptedMealTicks[today] = [...todayTicks, ...matchedMeals];
        await this.saveSettings();
        new Notice(`🔗 已自动同步打卡: ${matchedMeals.join("、")}`, 3500);

        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
        for (const l of leaves) {
          if (l.view instanceof DashboardView) await l.view.refresh();
        }
      }
    } catch (e) {
      console.warn("[PantryFin] 餐次同步失败:", e);
    }
  }

  /** 从食谱提取所有食材名，对比库存找出缺料，按日期存储 */
  private _logConsume(items: Array<{ name: string; amount_g: number }>, dateStr: string): void {
    if (!items || items.length === 0) return;
    this.settings.consumptionLog = this.settings.consumptionLog || {};
    for (const item of items) {
      if (!this.settings.consumptionLog[item.name]) this.settings.consumptionLog[item.name] = [];
      this.settings.consumptionLog[item.name]!.push({ date: dateStr, amount_g: item.amount_g });
      if (this.settings.consumptionLog[item.name]!.length > 60) {
        this.settings.consumptionLog[item.name] = this.settings.consumptionLog[item.name]!.slice(-60);
      }
    }
  }

  /** v4.2 从单餐文件中匹配该餐的消耗项（日索引不含每餐用料详情） */
  private async _extractMealConsumeFromFile(
    dateStr: string, mealLabel: string,
    allConsume: Array<{ name: string; amount_g: number }>
  ): Promise<Array<{ name: string; amount_g: number }>> {
    const mealPath = this.mealPlanWriter.getSingleMealPath(
      this.settings.mealPlanFolder, dateStr, mealLabel
    );
    const mealFile = this.app.vault.getAbstractFileByPath(mealPath);
    if (!(mealFile instanceof TFile)) {
      // 单餐文件不存在 → 回退到全文过滤
      const indexPath = `${this.settings.mealPlanFolder}/${MealPlanWriter.datePath(dateStr)}.md`;
      const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
      if (indexFile instanceof TFile) {
        const content = await this.app.vault.read(indexFile);
        return this._filterConsumeByMeal(content, allConsume, mealLabel);
      }
      return [];
    }

    const mealContent = await this.app.vault.read(mealFile);
    const mealConsume: Array<{ name: string; amount_g: number }> = [];

    for (const item of allConsume) {
      if (mealContent.includes(item.name)) {
        // 在餐文件内精确匹配克重/体积，捕获单位并当场转为基准值
        const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numRegex = new RegExp(`${escapedName}[^\\d\\r\\n]{0,15}(\\d+(?:\\.\\d+)?)\\s*(g|kg|ml|L|升|毫升|克|枚|个)?`, "i");
        const numMatch = mealContent.match(numRegex);
        if (numMatch && numMatch[1]) {
          const rawVal = parseFloat(numMatch[1]);
          const rawUnit = numMatch[2] || "g";
          if (!isNaN(rawVal) && rawVal > 0) {
            // 当场转为基准量 (g/ml): "1L"→1000, "2kg"→2000, "500ml"→500
            const baseVal = toBase({ value: rawVal, unit: rawUnit });
            mealConsume.push({ name: item.name, amount_g: baseVal });
          } else {
            mealConsume.push({ name: item.name, amount_g: item.amount_g });
          }
        } else {
          mealConsume.push({ name: item.name, amount_g: item.amount_g });
        }
      }
    }

    return mealConsume;
  }

  private _filterConsumeByMeal(content: string, allConsume: Array<{ name: string; amount_g: number }>, mealLabel?: string) {
    if (!mealLabel) return allConsume;
    const regex = new RegExp(`##\\s*[^#\n]*${mealLabel}[^\n]*`, "i");
    const match = content.match(regex);
    if (!match || match.index === undefined) return allConsume;

    const startIdx = match.index;
    const rest = content.slice(startIdx + match[0].length);
    const nextMatch = rest.match(/\n##\s/);
    const endIdx = nextMatch && nextMatch.index !== undefined ? nextMatch.index : rest.length;
    const mealText = rest.slice(0, endIdx);

    const mealConsume: Array<{ name: string; amount_g: number }> = [];

    for (const item of allConsume) {
      if (mealText.includes(item.name)) {
        const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const numRegex = new RegExp(`${escapedName}[^\\d\\r\\n]{0,15}(\\d+(?:\\.\\d+)?)\\s*(g|kg|ml|L|升|毫升|克|枚|个)?`, "i");
        const numMatch = mealText.match(numRegex);
        if (numMatch && numMatch[1]) {
          const rawVal = parseFloat(numMatch[1]);
          const rawUnit = numMatch[2] || "g";
          if (!isNaN(rawVal) && rawVal > 0) {
            const baseVal = toBase({ value: rawVal, unit: rawUnit });
            mealConsume.push({ name: item.name, amount_g: baseVal });
          } else {
            mealConsume.push({ name: item.name, amount_g: item.amount_g });
          }
        } else {
          mealConsume.push({ name: item.name, amount_g: item.amount_g });
        }
      }
    }

    return mealConsume;
  }

  async acceptMealPlanAndDeduct(dateStr: string, mealLabel?: string): Promise<void> {
    // 🌟 乐观更新：在第一步立刻更新内存中的打卡状态
    // 防止后续 deductStock 触发 vault modify → scheduleRender 提前重绘时读到旧值
    this.settings.acceptedMealTicks = this.settings.acceptedMealTicks || {};
    this.settings.acceptedMealTicks[dateStr] = this.settings.acceptedMealTicks[dateStr] || [];
    if (mealLabel && !this.settings.acceptedMealTicks[dateStr].includes(mealLabel)) {
      this.settings.acceptedMealTicks[dateStr].push(mealLabel);
    }

    const planFile = this.app.vault.getAbstractFileByPath(`${this.settings.mealPlanFolder}/${MealPlanWriter.datePath(dateStr)}.md`);
    if (!(planFile instanceof TFile)) {
      new Notice("⚠️ 未找到该日食谱笔记！");
      return;
    }

    const content = await this.app.vault.read(planFile);
    let consumeList: Array<{ name: string; amount_g: number }> = [];

    // 路径1: 解析 AI 标准 JSON 输出 {"consume": [...]}
    const jsonMatch = content.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)[\r\n]+\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        // 优先使用标准 consume 字段
        if (Array.isArray(parsed.consume)) {
          parsed.consume.forEach((p: any) => {
            if (p.name && p.amount_g) consumeList.push({ name: p.name, amount_g: Number(p.amount_g) });
          });
        }
        // 兼容顶层数组格式
        if (consumeList.length === 0 && Array.isArray(parsed)) {
          parsed.forEach((p: any) => {
            if (p.name && p.amount_g) consumeList.push({ name: p.name, amount_g: Number(p.amount_g) });
          });
        }
      } catch (e) {
        console.warn("PantryFin: 食谱 JSON 解析失败，尝试表解析", e);
      }
    }

    // 路径2: 表解析（只解析"今日消耗"区块下的表格，避免误读库存表）
    if (consumeList.length === 0) {
      const consumeSection = content.match(/##\s*📦\s*库存变动记录[\s\S]*?(?=\n##\s|\n---\s*$|$)/);
      const sectionText = consumeSection ? consumeSection[0] : "";
      const lines = (sectionText || content).split("\n");
      let inConsumeTable = false;
      for (const line of lines) {
        if (line.includes("今日消耗") || line.includes("消耗")) inConsumeTable = true;
        if (line.startsWith("##") && !line.includes("消耗")) inConsumeTable = false;
        if (!inConsumeTable) continue;
        if (!line.startsWith("|") || line.includes("---") || line.includes("食材") || line.includes("消耗量")) continue;
        const cells = line.split("|").map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          const name = cells[0]!;
          const numMatch = cells[1]!.match(/(\d+(?:\.\d+)?)/);
          if (name && numMatch && !isNaN(parseFloat(numMatch[1]!))) {
            consumeList.push({ name, amount_g: parseFloat(numMatch[1]!) });
          }
        }
      }
    }

    // 路径3: 从菜谱食材清单提取（匹配 "食材名 数字g" 模式）
    if (consumeList.length === 0) {
      const ingredientRegex = /[-*]\s*([一-龥]{1,8})\s*(\d+(?:\.\d+)?)\s*[gG克]/g;
      let m: RegExpExecArray | null;
      while ((m = ingredientRegex.exec(content)) !== null) {
        if (m[1] && m[2]) consumeList.push({ name: m[1], amount_g: parseFloat(m[2]) });
      }
    }

    if (consumeList.length === 0) {
      new Notice("⚠️ 未能从食谱中解析出食材消耗列表，请检查食谱格式。");
      return;
    }

    // v4.2 单餐筛选：日索引不含每餐用料详情 → 从单餐文件精确提取
    const isNewFormat = /generated_slots:/.test(content);
    let targetConsume = isNewFormat && mealLabel
      ? await this._extractMealConsumeFromFile(dateStr, mealLabel, consumeList)
      : this._filterConsumeByMeal(content, consumeList, mealLabel);

    if (targetConsume.length > 0) {
      const result = await this.pantryParser.deductStock(this.settings.pantryPath, targetConsume);
      const warnings = result.warnings;
      // 用实际扣减量(已转换计数类食材)更新存储, 确保 revert 精准恢复
      targetConsume = result.actualDeducted;
      const labelText = mealLabel ? `【${mealLabel}】` : "全天";
      
      // 调用本地计算引擎进行毫秒级精准营养核算
      const linesText = targetConsume.map(c => `${c.name} ${c.amount_g}g`).join('\n');
      let exactMsg = "";
      try {
        if (this.menuCalculator && this.foodDataLoader) {
          const calcResult = await this.menuCalculator.calculate(linesText, { loader: this.foodDataLoader });
          const cal = Math.round(calcResult.total['Energy'] || 0);
          const pro = Math.round(calcResult.total['Protein'] || 0);
          if (cal > 0) {
            exactMsg = `\n🛡️ 《中国食物成分表》精算热量: ${cal} kcal | 蛋白质: ${pro}g`;
          }
        }
      } catch (e) {
        console.warn("Local math engine calculation failed:", e);
      }

      new Notice(`🟢 成功接受${labelText}菜谱！扣除 ${targetConsume.length} 项库存。${exactMsg}`, 6000);
      if (warnings && warnings.length > 0) new Notice(`⚠️ 库存偏低:\n${warnings.join("\n")}`, 8000);
      this._logConsume(targetConsume, dateStr);  // 记录消耗
      this.api.hooks.trigger("stockChanged", { date: dateStr, meal: mealLabel });
      // v2.0: amount_g 已是 base 值，revert 直接加回即可，无需 revertStr
      this.settings.lastDeduction = this.settings.lastDeduction || {};
      this.settings.lastDeduction[`${dateStr}_${mealLabel || "全天"}`] = targetConsume;
      await this.memoryManager.appendMemory(`用户打勾接受 ${dateStr} ${labelText}食谱并扣减对应库存。${exactMsg ? "本地引擎核算:" + exactMsg : ""}`);
    } else {
      new Notice(`✅ 已确认接受${mealLabel || "方案"}！`);
    }

    await this.saveSettings();
    await this.syncMasterCenterNote();
  }

  async revertMealPlanDeduction(dateStr: string, mealLabel?: string): Promise<void> {
    // 🌟 乐观更新：第一步先移除内存中的打卡状态，防止提前重绘读旧值
    if (this.settings.acceptedMealTicks?.[dateStr] && mealLabel) {
      this.settings.acceptedMealTicks[dateStr] = this.settings.acceptedMealTicks[dateStr].filter(m => m !== mealLabel);
    }

    // 优先使用上次接受时精确存储的扣减记录，防止过度恢复
    const dedKey = `${dateStr}_${mealLabel || "全天"}`;
    const storedDeduction = this.settings.lastDeduction?.[dedKey];
    if (storedDeduction && storedDeduction.length > 0) {
      for (const item of storedDeduction) {
        // v2.0: amount_g 是 base 值，直接加回
        await this.pantryParser.manualAddOrMergeItem(this.settings.pantryPath, "食材", item.name, `${item.amount_g}g`);
      }
      const labelText = mealLabel ? `【${mealLabel}】` : "全天";
      new Notice(`🔄 已取消打勾！已回退恢复 ${storedDeduction.length} 项${labelText}耗材。`);
      // 清理已使用的扣减记录
      if (this.settings.lastDeduction) {
        delete this.settings.lastDeduction[dedKey];
      }
      await this.memoryManager.appendMemory(`用户取消打勾 ${dateStr} ${labelText}方案，系统回退复原对应库存。`);
    } else {
      // 无存储记录时退回旧逻辑
      new Notice("🔄 已取消记录（无精确扣减记录，库存未自动恢复）");
    }

    await this.saveSettings();
    await this.syncMasterCenterNote();
  }

  // ══════════════════════════════════════════════════════
  //  初始化与设置桥接
  // ══════════════════════════════════════════════════════

  private initServices(): void {
    this.profileParser = new ProfileParser(this.app);
    this.pantryParser = new PantryParser(this.app);
    this.mealPlanWriter = new MealPlanWriter(this.app);
    this.memoryManager = new MemoryManager(this.app);
    this.ruleManager = new RuleManager(this.app);
    this.localMathEngine = new LocalMathEngine(this.app, this.pantryParser, this.ruleManager);
    this.agyEngine = new AgyEngine({
      agyPath: this.settings.agyCLIPath,
      model: this.settings.agyModel || null,
      timeoutSeconds: this.settings.agyTimeoutSeconds,
      skipPermissions: true,
      aiProviderMode: this.settings.aiProviderMode ?? 'api',
      apiBaseUrl: this.settings.apiBaseUrl ?? 'https://api.deepseek.com',
      apiKey: this.settings.apiKey ?? '',
      apiModel: this.settings.apiModel ?? 'deepseek-v4-flash',
    });
    this.foodDataLoader = new FoodDataLoader(() => {
      return {
        adapter: this.app.vault.adapter,
        pluginDir: `.obsidian/plugins/${this.manifest.id}`
      } as any;
    });
    this.menuCalculator = new MenuCalculator();
    this.subagentRegistry = createDefaultRegistry();
    this.contextPackager = new ContextPackager();
    this.outputVerifier = new OutputVerifier(this.menuCalculator, this.foodDataLoader);
    this.recipeLibrary = new RecipeLibrary();
    this.cheatDayManager = new CheatDayManager(this);
    this.backupManager = new BackupManager(this);
    this.ingredientValidator = new IngredientValidator(this.agyEngine);
    this.automationEngine = new AutomationEngine();
    this.recipeScraper = new RecipeScraper();
    this.richRecipeScraper = new RichRecipeScraper();
    this.htmlArchiver = new HtmlArchiver(this.app);
  }

  private initScheduler(): void {
    this.scheduler = new CronScheduler({
      scheduledTime: this.settings.scheduledTime,
      graceWindowMinutes: 120,
      onTrigger: async () => {
        if (this.settings.autoGenerate) {
          await this.generateDailyPlan();
        }
      },
      hasPlanForToday: () => {
        const today = this.todayKey();
        return this.mealPlanWriter.hasPlanForDate(
          this.settings.mealPlanFolder,
          today
        );
      },
    });

    this.registerInterval(this.scheduler.start());
  }

  getPantryParser() {
    return this.pantryParser;
  }

  getAgyEngine() {
    return this.agyEngine;
  }

  /** v4.3: 在 Obsidian 内部打开离线 HTML 网页 */
  async _openHtmlInReader(file: TFile): Promise<void> {
    const { workspace } = this.app;
    let leaves = workspace.getLeavesOfType(VIEW_TYPE_HTML_READER);
    // 复用已有阅读器 leaf
    let leaf = leaves[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_HTML_READER, active: true });
    }
    workspace.revealLeaf(leaf);
    if (leaf.view instanceof HtmlReaderView) {
      await leaf.view.loadHtml(file);
    }
  }

  async activateDashboard(): Promise<void> {
    const { workspace } = this.app;

    // 自动检测：无档案时自动创建模板，不强制进入 AI 聊天室
    const profilePath = this.settings.profilePath;
    const profileFile = this.app.vault.getAbstractFileByPath(profilePath);
    if (!(profileFile instanceof TFile)) {
      await this.ensureTemplates();
    }

    let leaves = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
    let leaf = leaves[0];

    // 如果当前在侧边栏，先移除，确保像文件一样在中央编辑区覆盖全页面打开
    if (leaf && leaf.getRoot() !== workspace.rootSplit) {
      workspace.detachLeavesOfType(VIEW_TYPE_DASHBOARD);
      leaf = undefined;
    }

    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({
        type: VIEW_TYPE_DASHBOARD,
        active: true,
      });
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async handleDailyAgentCommand(userInput: string, onChunk?: (text: string) => void): Promise<string | null> {
    // ── 0. 优先执行本地确定性内核拦截计算（买菜、消耗扣减、铁律纠错、改体重）──
    const intercept = await this.localMathEngine.tryIntercept(userInput, this.settings.pantryPath, this.settings.profilePath);
    if (intercept.handled) {
      await this.syncMasterCenterNote();
      if (intercept.triggerPlan) setTimeout(() => this.generateDailyPlan(), 500);
      const replyText = intercept.reply || "底层逻辑计算完毕！";
      if (onChunk) onChunk(replyText);
      return replyText;
    }

    const profile = await this.profileParser.readProfile(this.settings.profilePath);
    const pantry = await this.pantryParser.readPantry(this.settings.pantryPath);

    const fullIntent = /历史|之前|上个月|曾经|全部|以前/.test(userInput);
    const memContext = fullIntent 
      ? await this.memoryManager.getFullMemory() 
      : await this.memoryManager.getRecentMemorySlice(3);
    const rulesText = await this.ruleManager.getRules();

    // ── Layer 1: 本地预计算上下文 ──
    let ctxPackage: any = null;
    if (profile) {
      ctxPackage = await this.contextPackager.build(profile, pantry,
        this.todayKey(), memContext, rulesText);
    }

    // ── Subagent 专家路由体系（可注册路由表，支持动态扩展）──
    const routedAgent = this.subagentRegistry.route(userInput);
    const subagentName = routedAgent.name;
    const subagentInstruction = routedAgent.instruction;


    // 使用预计算结果构建精简 Prompt（若有 profile 则包含 BMR/TDEE）
    const profileBlock = ctxPackage
      ? `## 用户档案
${ctxPackage.profileSummary}
- 基础代谢 BMR: ${ctxPackage.computed.bmr} kcal
- 每日消耗 TDEE: ${ctxPackage.computed.tdee} kcal
- 目标热量: ${ctxPackage.computed.targetCalories} kcal
- 宏量素目标: 蛋白质 ${ctxPackage.computed.macroTargets.protein_g}g 碳水 ${ctxPackage.computed.macroTargets.carbs_g}g 脂肪 ${ctxPackage.computed.macroTargets.fat_g}g`
      : `## ⚠️ 用户身体档案尚未创建
请提醒用户先在 ${this.settings.profilePath} 中填写身高、体重、年龄、目标等基本信息。`;

    const pantryBlock = ctxPackage
      ? `## 库存摘要\n${ctxPackage.pantryDigest.summaryText}`
      : `## 当前食材库存清单\n${JSON.stringify(pantry)}`;

    const prompt = `【当前激活 Subagent 子代理】：${subagentName}
用户发来了一句日常指令："${userInput}"

### 🚨 用户最高优先级永久规范与铁律（必须100%严格遵守）
${rulesText}
🚨 系统铁律：所有食材建议必须基于「库存摘要」中真实存在的食材，只能额外使用基础调料。禁止虚构库存中没有的食材！

${profileBlock}

${pantryBlock}

## AI健全记忆库与方案沉淀切片
${memContext}

${subagentInstruction}
通用规则：若发现值得沉淀的习惯喜好或偷吃记录，在 memory_log 简要总结一句话。

你必须输出一个纯 JSON 对象（不要用 \`\`\`json 包裹）：
{
  "reply": "【${subagentName}】简短幽默贴心的极客回复",
  "add_items": [],
  "consume_items": [],
  "update_profile": {},
  "memory_log": "",
  "trigger_plan": false
}`;

    this._aiPending++;
    let rawOutput: string | null = null;
    if (onChunk && typeof this.agyEngine.callApiStreamSafe === "function") {
      await new Promise<void>((resolve) => {
        this.agyEngine.callApiStreamSafe(prompt, (chunkReply) => {
          onChunk(chunkReply);
        }, (fullText) => {
          rawOutput = fullText;
          resolve();
        });
      });
    } else {
      rawOutput = await this.agyEngine.executeRaw(prompt);
    }
    this._aiPending--;
    if (!rawOutput) {
      return "⚠️ [云端连接超时] AI 营养师联网推演通道暂时无响应（可能是官方 API 波动或网络代理限流）。\n💡 提示：记买菜入库、消耗快扣、铁律录入、体重修改等核心功能由确定性内核100%本地计算，不受网络影响！";
    }

    const clean = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
  
    // 优先: 直接 JSON.parse（response_format: json_object 保证合法 JSON）
    let data: any = null;
    try {
      data = JSON.parse(clean);
    } catch {
      // 回退: 旧版 ```json 代码块提取
      const jsonMatch = clean.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)[\r\n]+\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        try { data = JSON.parse(jsonMatch[1]); } catch {}
      }
    }

    let replyText = data?.reply || clean.replace(/```(?:json)?[\s\S]*?```/g, "").trim();

    if (data) {
      try {

        if (data.reply) replyText = data.reply;

        if (Array.isArray(data.add_items) && data.add_items.length > 0) {
          const pFile = this.app.vault.getAbstractFileByPath(this.settings.pantryPath);
          if (pFile instanceof TFile) {
            let pContent = await this.app.vault.read(pFile);
            const todayStr = this.todayKey();
            for (const item of data.add_items) {
              pContent += `| ${item.category || "食材"} | ${item.name} | ${item.quantity} | ${todayStr} | ${item.expiry || "2026-07-05"} | 🟢 充足 |\n`;
            }
            await this.app.vault.modify(pFile, pContent);
            new Notice(`🛒 成功采购入库 ${data.add_items.length} 项新食材！`);
            this.api.hooks.trigger("stockChanged", { action: "add" });
          }
        }

        if (Array.isArray(data.consume_items) && data.consume_items.length > 0) {
          // Layer 3: AI 输出本地验证（防止幻觉污染库存）
          const verifyReport = await this.outputVerifier.verify(data.consume_items, pantry);
          if (verifyReport.rejected.length > 0) {
            new Notice(`🚫 ${verifyReport.rejected.length} 项消耗指令被拦截: ${verifyReport.rejected.map(r => r.issue).join("; ")}`, 6000);
          }
          const toExecute = verifyReport.safe;
          if (toExecute.length > 0) {
            const { warnings } = await this.pantryParser.deductStock(this.settings.pantryPath, toExecute);
            if (warnings && warnings.length > 0) new Notice(`⚠️ 库存低警报:\n${warnings.join("\n")}`, 6000);
            this._logConsume(toExecute, this.todayKey());
            await this.saveData(this.settings);  // 持久化消耗日志
            this.api.hooks.trigger("stockChanged", { action: "deduct" });
          }
          if (verifyReport.needsConfirmation.length > 0) {
            new Notice(`ℹ️ ${verifyReport.needsConfirmation.map(v => v.issue).join("\n")}`, 6000);
          }

          // 智能同步：检测消耗食材是否匹配今日食谱中的餐次，自动勾选
          if (toExecute.length > 0) {
            await this._syncMealTicksFromConsume(toExecute);
          }
        }

        if (data.update_profile && Object.keys(data.update_profile).length > 0) {
          const prFile = this.app.vault.getAbstractFileByPath(this.settings.profilePath);
          if (prFile instanceof TFile) {
            let prText = await this.app.vault.read(prFile);
            for (const [k, v] of Object.entries(data.update_profile)) {
              const reg = new RegExp(`(${k}:\\s*)[^\\r\\n]+`, "g");
              if (reg.test(prText)) {
                prText = prText.replace(reg, `$1${v}`);
              } else {
                prText = prText.replace("body:\n", `body:\n  ${k}: ${v}\n`);
              }
            }
            await this.app.vault.modify(prFile, prText);
            new Notice(`⚖️ 身体数据已自动同步！`);
          }
        }

        if (data.memory_log) {
          await this.memoryManager.appendMemory(data.memory_log);
        }

        if (data.trigger_plan) {
          setTimeout(() => this.generateDailyPlan(), 500);
        }
      } catch (e) {
        console.warn("管家 JSON 解析失败", e);
      }
    }

    await this.syncMasterCenterNote();
    return replyText || "执行完毕！";
  }

  /**
   * 核心中央操作系统挂载引擎：将所有散落数据一键编译为小组件布局中心笔记
   */
  async syncMasterCenterNote(): Promise<void> {
    // 锁防并发写：若已有同步在进行，跳过本次（保证最终一致性即可）
    if (this._syncLock) return;
    this._syncLock = true;
    try {
      const today = this.todayKey();
      const profile = await this.profileParser.readProfile(this.settings.profilePath);
      const pantry = await this.pantryParser.readPantry(this.settings.pantryPath);
      const memSlice = await this.memoryManager.getRecentMemorySlice(5);

      let planContent = "今日食谱计划尚未生成。";
      const planFile = this.app.vault.getAbstractFileByPath(`${this.settings.mealPlanFolder}/${MealPlanWriter.datePath(today)}.md`);
      if (planFile instanceof TFile) {
        planContent = await this.app.vault.read(planFile);
      }

      const pantryRows = pantry.map(i => `| ${i.category} | ${i.name} | ${i.quantity} | ${i.expiryDate} | ${i.priority} |`).join("\n");

      const noteText = `---
type: nutri-center
updated: ${today}
tags: [nutri-center, os-widgets]
---
# 🐟 PantryFin 智能膳食中央控制台

> [!info]+ 📊 专属身体指标与热量目标
> - **身高**: ${profile?.body?.height_cm || 175} cm | **体重**: ${profile?.body?.weight_kg || 70} kg | **年龄**: ${profile?.body?.age || 25} 岁
> - **运动系数**: ${profile?.body?.activity_level || "light"} | **核心目标**: ${profile?.goal?.type || "fat_loss"}

> [!todo]+ 📦 实时库仓表 (对话自动扣减)
| 类别 | 食材名称 | 当前数量 | 保质期至 | 预警状态 |
| :--- | :--- | :--- | :--- | :--- |
${pantryRows || "| 暂无 | 暂无 | 0g | - | 🟢 |"}

> [!tip]+ 🍽️ 今日早午晚餐规划安排 (${today})
${planContent.replace(/---[\s\S]*?---/, "").trim()}

> [!abstract]+ 🧠 AI 进化记忆引擎 (永久留存，智能窗口阅读)
${memSlice}
`;

      const masterPath = "Diet/智能膳食中心.md";
      let file = this.app.vault.getAbstractFileByPath(masterPath);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, noteText);
      } else {
        await this.app.vault.create(masterPath, noteText);
      }
    } catch (err) {
      console.warn("编译单文件中心笔记异常", err);
    } finally {
      this._syncLock = false;
    }
  }

  async saveOnboardingProfile(profile: any): Promise<void> {
    const vault = this.app.vault;
    const profilePath = this.settings.profilePath;

    const yamlContent = `---
height_cm: ${profile.body?.height_cm || 175}
weight_kg: ${profile.body?.weight_kg || 70}
age: ${profile.body?.age || 25}
gender: ${profile.body?.gender || "male"}
activity_level: ${profile.body?.activity_level || "moderate"}
goal_type: ${profile.goal?.type || "fat_loss"}
target_weight_kg: ${profile.goal?.target_weight_kg || 65}
weekly_rate_kg: ${profile.goal?.weekly_rate_kg || -0.5}
allergies: ${JSON.stringify(profile.preferences?.allergies || [])}
dislikes: ${JSON.stringify(profile.preferences?.dislikes || [])}
dietary_style: ${profile.preferences?.dietary_style || "balanced"}
---
# 🥗 个人专属智能营养档案

> 本档案由 AI 营养师聊天采访流自动生成。
`;
    const dir = profilePath.substring(0, profilePath.lastIndexOf("/"));
    if (dir && !vault.getAbstractFileByPath(dir)) {
      await vault.createFolder(dir);
    }

    const existing = vault.getAbstractFileByPath(profilePath);
    if (existing instanceof TFile) {
      await vault.modify(existing, yamlContent);
    } else {
      await vault.create(profilePath, yamlContent);
    }

    const pantryPath = this.settings.pantryPath;
    if (!vault.getAbstractFileByPath(pantryPath)) {
      const pantryContent = `# 🥬 食材库存清单\n\n| 食材类别 | 食材名称 | 当前数量/克重 | 采购日期 | 保质期至 | 优先级（预警） |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n| 蛋白质 | 鸡胸肉 | 600g | ${this.todayKey()} | 2026-06-30 | 🟢 充足 |\n`;
      await vault.create(pantryPath, pantryContent);
    }
    await this.syncMasterCenterNote();
  }

  async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    // Templater 风格: 版本化迁移 → normalize → 保存
    const migration = migrateSettings(raw, DEFAULT_SETTINGS);
    this.settings = migration.settings;
    this.normalizeSettings();
    if (migration.wasMigrated) {
      log_info(`设置已迁移: ${migration.migrationNotes.join("; ")}`);
      await this.saveData(this.settings);
    }
  }

  /** 加载后修复数据结构 (Yori store.js 借鉴) */
  private normalizeSettings(): void {
    const s = this.settings;
    s.acceptedMealTicks = s.acceptedMealTicks || {};
    s.lastDeduction = s.lastDeduction || {};
    s.chatHistory = s.chatHistory || {};
    s.consumptionLog = s.consumptionLog || {};
    s.missingIngredients = s.missingIngredients || {};
    s.shoppingTasks = s.shoppingTasks || {};
    s.showCard = s.showCard || { chat: true, diet: true, pantry: true, tasks: true, tracker: true };
    s.mealReplacements = s.mealReplacements || {};
    // 清理旧版小数 servings 残留
    for (const date of Object.keys(s.mealReplacements)) {
      for (const slot of Object.keys(s.mealReplacements[date] || {})) {
        const e = (s.mealReplacements[date] as any)?.[slot];
        if (e?.servings !== undefined && e.servings !== Math.round(e.servings)) {
          e.servings = Math.max(1, Math.round(e.servings));
        }
      }
    }
    s.foodAliases = s.foodAliases || {};
    s.automationRules = s.automationRules || [];
    // 兼容旧字段迁移
    if (!s.mealReplacements || Object.keys(s.mealReplacements).length === 0) {
      const oldSelections = (s as any).cheatDaySelections;
      if (oldSelections && Object.keys(oldSelections).length > 0) {
        s.mealReplacements = {};
        for (const [date, sel] of Object.entries(oldSelections)) {
          if ((sel as any).meals) {
            s.mealReplacements[date] = (sel as any).meals;
          }
        }
      }
    }
    if (typeof s.agyTimeoutSeconds !== "number" || isNaN(s.agyTimeoutSeconds)) s.agyTimeoutSeconds = 300;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.scheduler) {
      this.scheduler.updateScheduledTime(this.settings.scheduledTime);
    }
    // 热更新 AgyEngine API 配置，无需重启插件
    if (this.agyEngine) {
      this.agyEngine.updateApiConfig({
        apiBaseUrl: this.settings.apiBaseUrl,
        apiKey: this.settings.apiKey,
        apiModel: this.settings.apiModel,
        aiProviderMode: this.settings.aiProviderMode,
      });
    }
  }

  reinitServices(): void {
    this.initServices();
  }

  async getTargetCalories(): Promise<number> {
    try {
      const profile = await this.profileParser.readProfile(this.settings.profilePath);
      if (profile && this.contextPackager) {
        const bmr = this.contextPackager.computeBMR(profile);
        const tdee = this.contextPackager.computeTDEE(bmr, profile.body.activity_level);
        return this.contextPackager.computeTargetCalories(tdee, profile.goal.type, profile.goal.weekly_rate_kg);
      }
    } catch (e) {
      console.warn("[PantryFin] 读取真实目标热量失败，默认使用 2000:", e);
    }
    return 2000;
  }


  /** DashboardView 调用，持久化聊天历史到插件数据 */
  async saveChatHistory(history: Record<string, Array<{ sender: string; text: string }>>): Promise<void> {
    this.settings.chatHistory = history;
    await this.saveData(this.settings);
  }

  // ══════════════════════════════════════════════════════
  //  Museum Desk Helper Methods
  // ══════════════════════════════════════════════════════


  async importRecipeFromUrl(): Promise<void> {
    const url = prompt("🌐 粘贴食谱网页链接\n\n支持下厨房、美食天下、AllRecipes、BBC 等网站：");
    if (!url || !url.trim()) return;
    new Notice("⏳ 正在解析食谱...");
    try {
      const resp = await (this.app.vault.adapter as any).requestUrl?.({ url: url.trim(), method: "GET" })
        || await fetch(url.trim());
      const html = typeof resp === "string" ? resp : (resp.text || (await (resp as Response).text()));
      let richRecipe = this.richRecipeScraper?.scrapeFromHtml(html, url.trim());
      if (!richRecipe || richRecipe.ingredients.length === 0) {
        const agy = this.getAgyEngine();
        if (agy) {
          new Notice("🤖 结构化提取未命中，正在尝试 AI 图文提取...");
          richRecipe = await this.richRecipeScraper?.scrapeFromHtmlWithAI(html, agy, url.trim());
        }
      }
      if (richRecipe && richRecipe.ingredients.length > 0) {
        const folder = this.settings.mealPlanFolder || "PantryFin";
        await this.ensureNote(`${folder}/_placeholder`);
const cleanName = richRecipe.name.replace(/[\\/:*?"<>|]/g, "_");
        let filePath = `${folder}/食谱-${cleanName}.md`;
        if (this.app.vault.getAbstractFileByPath(filePath)) {
          const domain = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; } })();
          const suffix = domain ? ` (${domain.split(".")[0]})` : " (另一做法)";
          filePath = `${folder}/食谱-${cleanName}${suffix}.md`;
          let counter = 2;
          while (this.app.vault.getAbstractFileByPath(filePath)) {
            filePath = `${folder}/食谱-${cleanName}${suffix}${counter}.md`;
            counter++;
          }
        }
        let totalCals = 0;
        const db = getFoodDatabase();
        for (const ing of richRecipe.ingredients) {
          const match = db.lookupChinese(ing.name);
          const cals = match?.nutrients?.Energy ?? 0;
          totalCals += cals ? Math.round((ing.grams / 100) * cals) : 0;
        }
        let content = RichRecipeScraper.toMarkdown(richRecipe, totalCals);

        // Track B: 离线网页存档
        const archivePath = await this.htmlArchiver.archive(
          html, url.trim(), richRecipe.name,
          (msg: string) => { new Notice(msg, 3000); }
        );
        if (archivePath) {
          const basePath = (this.app.vault.adapter as any).getBasePath ? (this.app.vault.adapter as any).getBasePath() : "";
          const browserUrl = basePath ? `file://${basePath}/${archivePath}`.replace(/ /g, "%20") : archivePath;
          const resourceUrl = this.app.vault.adapter.getResourcePath(archivePath);

          content += `\n\n---\n\n## 🌐 完整网页版\n\n- [🚀 在系统浏览器中打开原网页 (100%排版保真)](${browserUrl})\n- [📄 查看本地源码附件](${archivePath})\n\n<details>\n  <summary>💻 笔记内实时预览网页 (点击展开)</summary>\n  <iframe src="${resourceUrl}" width="100%" height="650px" style="border:1px solid #e0e0e0; border-radius:8px; margin-top:10px;"></iframe>\n</details>\n`;
          new Notice(`📦 离线网页已存档: ${archivePath}`, 4000);
        }

        await this.app.vault.create(filePath, content);
        new Notice(`✅ 食谱笔记已创建: ${filePath}`);
        await this.openPath(filePath);
      } else {
        new Notice("⚠️ 未能解析出食谱，请确认链接是食谱网页");
      }
    } catch (e) {
      new Notice(`❌ 导入失败: ${(e as Error).message || "网络错误"}`);
    }
  }

  async openPath(path: string, sourcePath = ""): Promise<void> {
    const normalized = (path.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0] ?? "").trim();
    await this.ensureNote(normalized);
    await this.app.workspace.openLinkText(normalized, sourcePath, true);
  }

  async openFolder(path: string): Promise<void> {
    const folderPath = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    const leaf = this.app.workspace.getLeaf(true);
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(`${folderPath}/`))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    if (files[0]) {
      await leaf.openFile(files[0]);
    } else {
      const note = await this.ensureNote(`${folderPath}/${folderPath.split("/").pop()}主页`);
      await leaf.openFile(note);
    }
    new Notice(`已打开 ${folderPath}`);
  }

  async ensureNote(path: string): Promise<TFile> {
    const normalized = normalizePath(path.endsWith(".md") ? path : `${path}.md`);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) return existing;

    const folder = normalized.split("/").slice(0, -1).join("/");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    return this.app.vault.create(normalized, `# ${normalized.split("/").pop()?.replace(/\.md$/, "")}\n\n`);
  }

  async appendToNote(path: string, text: string): Promise<void> {
    const file = await this.ensureNote(path);
    await this.app.vault.append(file, text);
  }

  todayKey(date = new Date()): string {
    const year = date.getFullYear();
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async findOpenTasks(limit = 6): Promise<TaskHit[]> {
    const stats = await this.getTodayTaskStats();
    return stats.tasks.filter((task) => !task.done).slice(0, limit);
  }

  async getTodayTaskStats(): Promise<TodayTaskStats> {
    const hits: TaskHit[] = [];
    const today = this.todayKey();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !file.path.startsWith("Diet/Data/"));
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        const match = line.match(/^\s*-\s\[([ xX])\]\s(.+)/);
        if (!match) return;
        const textStr = match[2] ?? "";
        if (!textStr.includes(today)) return;
        hits.push({
          file,
          line: index,
          text: textStr,
          done: (match[1] ?? "").toLowerCase() === "x"
        });
      });
    }
    return {
      total: hits.length,
      open: hits.filter((task) => !task.done).length,
      tasks: hits
    };
  }

  async completeTask(task: TaskHit): Promise<void> {
    await this.app.vault.process(task.file, (content) => {
      const lines = content.split("\n");
      const doneLine = (lines[task.line] ?? "").replace(/\[\s\]/, "[x]");
      lines[task.line] = doneLine.includes("✅") ? doneLine : `${doneLine} ✅ ${this.todayKey()}`;
      return lines.join("\n");
    });
  }

}

// force include
