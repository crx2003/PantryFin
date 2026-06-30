// src/views/DashboardView.ts

import { ItemView, WorkspaceLeaf, TFile, Notice, Platform } from "obsidian";
import type NutriAgentPlugin from "../main";
import type { NutriAgentAPI } from "../api";
import { MEAL_SLOTS, type MealSlot, type CheatDaySelection, type CheatDayEntry, type ParsedRecipe } from "../models/types";
import { RecipePickerModal } from "./RecipePickerModal";
import { ICardContext } from "./cards/BaseCard";
import { ButlerChatCard } from "./cards/ButlerChatCard";
import { MealTrackerCard } from "./cards/MealTrackerCard";
import { DietGuideCard } from "./cards/DietGuideCard";
import { TasksCard } from "./cards/TasksCard";
import { PantryCard } from "./cards/PantryCard";

export const VIEW_TYPE_DASHBOARD = "pantryfin-dashboard";

type HeroMode = "day" | "week" | "month" | "year";

/**
 * 仪表盘插件上下文接口。
 * 解决 import type 导致的 (plugin as any) 类型不安全问题。
 * DashboardView 通过此接口获得对插件公开方法的类型安全访问。
 * 借鉴 obsidian-react-components 的 scope 注入模式。
 */
interface IPluginContext {
  settings: {
    profilePath: string; pantryPath: string; mealPlanFolder: string;
    agyCLIPath: string; agyModel: string; agyTimeoutSeconds: number;
    aiProviderMode?: 'api' | 'cli'; apiBaseUrl?: string; apiKey?: string; apiModel?: string;
    scheduledTime: string; autoGenerate: boolean;
    acceptedMealTicks?: Record<string, string[]>;
    heroTitle?: string; studyTitle?: string; focusTitle?: string;
    habitNames?: string[]; habitLogs?: Record<string, string[]>;
    cardImages?: Record<string, string>;
    consumptionLog?: Record<string, Array<{ date: string; amount_g: number }>>;
    mealReplacements?: Record<string, any>;
    showCard?: Record<string, boolean>;
    chatHistory?: Record<string, Array<{ sender: string; text: string }>>;
  };
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
}

/**
 * WeakRef 包装类型，用于追踪卡片 DOM 元素生命周期。
 * 借鉴 obsidian-react-components 的 asWeak / asStrong 模式。
 */
interface CardRef {
  area: string;
  element: WeakRef<HTMLElement>;
}

export class DashboardView extends ItemView {
  plugin: IPluginContext;

  // WeakRef 卡片生命周期追踪（借鉴 obsidian-react-components 模式）
  private _cardRefs: CardRef[] = [];

  private dailyMessages: Array<{ sender: "user" | "ai"; text: string }> = [
    {
      sender: "ai",
      text: "🥗 专属智能营养管家全天候在线！您可以发：\n• 「买了一盒牛奶和500克牛肉」\n• 「今天瘦了，体重更新为71kg」\n• 「帮我重新生成今天的菜谱」",
    },
  ];
  private isDailyThinking: boolean = false;
  private streamingReply: { text: string } | null = null;

  // ── 仪表盘内部状态 ──
  private heroMode: HeroMode = "day";
  private mealTrackerDate: Date = new Date();
  private _mealActionBusy = false;  // 打卡防重入

  private _isRenderingLocked: boolean = false;
  private _renderHandle: number | null = null;  // requestAnimationFrame ID
  private _isOpen: boolean = false;
  private _cachedTargetCal: number = 2000;

  constructor(leaf: WorkspaceLeaf, plugin: IPluginContext) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return "PantryFin";
  }

  getIcon(): string {
    return "salad";
  }

  async onOpen(): Promise<void> {
    this._isOpen = true;
    this.containerEl.addClass("museum-home-view");
    // 恢复今日聊天历史
    const today = this.plugin.todayKey();
    const history = (this.plugin.settings as any).chatHistory?.[today];
    if (history && history.length > 0) {
      this.dailyMessages = history;
    }
    this.scheduleRender();
    // 等待 grid 渲染完成后滚动到顶部
    this.waitForElement(".museum-home-grid").then(() => this.scrollToTop());

    // Zotero Better Notes 风格 Hooks: 订阅食谱生成/库存变更事件，自动刷新
    const api = (this.plugin as any).api;
    if (api?.hooks) {
      api.hooks.on("planGenerated", () => this.forceRefresh());
      api.hooks.on("stockChanged", () => this.scheduleRender());
    }

    // 监听笔记实时修改保存，实现控制台小组件无感实时自动更新
    // P1: 500ms 防抖，避免 AI 生成多文件时重复渲染
    let modifyTimeout: number | null = null;
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path.startsWith("Diet/")) {
          const tag = document.activeElement?.tagName;
          if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || this.containerEl.querySelector('.nutri-manual-form[style*="flex"]') || this.isDailyThinking || this._mealActionBusy) return;
          if (modifyTimeout) clearTimeout(modifyTimeout);
          modifyTimeout = window.setTimeout(() => {
            modifyTimeout = null;
            this.scheduleRender();
          }, 500);
        }
      })
    );
  }

  /**
   * MutationObserver 延迟挂载：等待目标元素出现后 resolve。
   * 借鉴 obsidian-react-components 的 componentsWaitingToLoad + MutationObserver 模式。
   */
  private waitForElement(selector: string, timeoutMs = 5000): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const existing = this.containerEl.querySelector<HTMLElement>(selector);
      if (existing) { resolve(existing); return; }

      const observer = new MutationObserver(() => {
        const el = this.containerEl.querySelector<HTMLElement>(selector);
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(this.containerEl, { childList: true, subtree: true });

      setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
    });
  }

  /** 两阶段清理 */
  async onClose(): Promise<void> {
    this._isOpen = false;
    if (this._renderHandle !== null) { cancelAnimationFrame(this._renderHandle); this._renderHandle = null; }
    for (const ref of this._cardRefs) {
      const el = ref.element.deref();
      if (el) el.replaceChildren();
    }
    this._cardRefs = [];
  }

  /** 强制立即刷新（供外部调用，如食谱生成后同步更新看板） */
  async refresh(): Promise<void> {
    if (!this._isOpen) return;
    await this.render();
  }

  /** 强制无锁刷新：取消待处理的 rAF、等待当前渲染完成、然后重新渲染 */
  async forceRefresh(): Promise<void> {
    if (!this._isOpen) return;
    if (this._renderHandle !== null) {
      cancelAnimationFrame(this._renderHandle);
      this._renderHandle = null;
    }
    // 短暂等待确保异步保存完成
    await new Promise(r => setTimeout(r, 150));
    this._isRenderingLocked = false;
    await this.render();
  }

  /** Yori 风格: requestAnimationFrame 调度，帧同步 + Tab 不可见时自动暂停 */
  scheduleRender(): void {
    if (!this._isOpen) return;
    if (this._renderHandle !== null) cancelAnimationFrame(this._renderHandle);
    this._renderHandle = requestAnimationFrame(async () => {
      this._renderHandle = null;
      if (!this._isOpen) return;
      await this.render();
    });
  }

  scrollToTop(): void {
    const scroller = this.containerEl.querySelector<HTMLElement>(".view-content");
    if (scroller) scroller.scrollTop = 0;
  }

  /**
   * ErrorBoundary 卡片隔离包装器：捕获单张卡片渲染异常，防止崩溃扩散到整个仪表盘。
   * 同时用 WeakRef 追踪卡片 DOM 元素，支持 GC 友好回收。
   * 借鉴 obsidian-react-components 的 ErrorBoundary + WeakRef 模式。
   */
  private async renderCardSafe(
    grid: HTMLElement,
    cardName: string,
    cardArea: string,
    renderFn: () => void | Promise<void>
  ): Promise<void> {
    try {
      // 记录旧卡片引用，两阶段渲染：旧 ref 将在下次 sweep 时回收
      const oldCard = grid.querySelector(`.area-${cardArea}`) as HTMLElement | null;
      if (oldCard) {
        this._cardRefs.push({ area: cardArea, element: new WeakRef(oldCard) });
      }

      await renderFn();

      // 记录新卡片，并清理已死亡的 WeakRef
      const newCard = grid.querySelector(`.area-${cardArea}`) as HTMLElement | null;
      if (newCard) {
        this._cardRefs.push({ area: cardArea, element: new WeakRef(newCard) });
      }
      this._sweepDeadRefs();
    } catch (err) {
      console.error(`[PantryFin] 卡片 [${cardName}] 渲染崩溃，已隔离:`, err);
      const errorCard = grid.createDiv({
        cls: `museum-live-card area-${cardArea} museum-dashboard-error`,
        attr: { style: "min-height: 120px;" }
      });
      errorCard.createEl("strong", { text: `⚠️ ${cardName} 加载失败` });
      errorCard.createEl("p", {
        text: `${(err as Error).message || "未知错误"}`,
        attr: { style: "font-size: 11px; color: var(--nd-text-soft); margin-top: 6px;" }
      });
    }
  }

  /** 持久化当日聊天记录到插件设置 */
  private persistChatHistory(): void {
    try {
      const today = this.plugin.todayKey();
      const history: Record<string, Array<{ sender: string; text: string }>> = {};
      // 合并现有历史记录
      const existing = this.plugin.settings.chatHistory;
      if (existing) Object.assign(history, existing);
      history[today] = this.dailyMessages.slice(-50);  // 保留最近50条
      this.plugin.saveChatHistory(history);
    } catch (e) {
      console.warn("[PantryFin] 聊天历史持久化失败:", e);
    }
  }

  /** 清理已死亡的 WeakRef 条目，允许 GC 回收旧的 DOM 元素 */
  private _sweepDeadRefs(): void {
    this._cardRefs = this._cardRefs.filter(ref => ref.element.deref() !== undefined);
  }

  async render(): Promise<void> {
    if (!this._isOpen) return;
    // 等待当前渲染完成
    if (this._isRenderingLocked) {
      await new Promise(r => setTimeout(r, 100));
      if (this._isRenderingLocked) return; // 超时放弃
    }
    this._isRenderingLocked = true;

    try {
      if ((this.plugin as any).getTargetCalories) {
        const c = await (this.plugin as any).getTargetCalories();
        if (c > 0) this._cachedTargetCal = c;
      }
      const root = this.contentEl;
      // Phase 1: 解除已脱离 DOM 树的旧卡片引用，允许 GC 回收
      for (const ref of this._cardRefs) {
        const el = ref.element.deref();
        if (el && !root.contains(el)) {
          el.replaceChildren();
        }
      }
      root.empty();
      root.addClass("museum-home-view-content");

      const grid = root.createDiv({ cls: "museum-home-grid" });

      // 每张卡片独立 ErrorBoundary + WeakRef 隔离 + Yori 风格显隐开关
      // 新布局: Chat+Tracker | Diet(主)+Tasks | Pantry 全宽
      const sc = this.plugin.settings.showCard || {};
      const ctx: ICardContext = {
        app: this.app,
        plugin: this.plugin as unknown as import("../main").default,
        settings: this.plugin.settings,
        todayKey: (d) => this.plugin.todayKey(d),
        getAgyEngine: () => this.plugin.getAgyEngine(),
        getPantryParser: () => this.plugin.getPantryParser(),
        pantryParser: this.plugin.pantryParser,
        cheatDayManager: this.plugin.cheatDayManager,
        recipeLibrary: this.plugin.recipeLibrary,
        generateDailyPlan: (d) => this.plugin.generateDailyPlan(d),
        acceptMealPlanAndDeduct: (ds, ml) => this.plugin.acceptMealPlanAndDeduct(ds, ml),
        revertMealPlanDeduction: (ds, ml) => this.plugin.revertMealPlanDeduction(ds, ml),
        handleDailyAgentCommand: (ui, cb) => this.plugin.handleDailyAgentCommand(ui, cb),
        syncMasterCenterNote: () => this.plugin.syncMasterCenterNote(),
        openPath: (p, s) => this.plugin.openPath(p, s),
        openFolder: (p) => this.plugin.openFolder(p),
        findOpenTasks: (l) => this.plugin.findOpenTasks(l),
        completeTask: (t) => this.plugin.completeTask(t),
        saveChatHistory: (h) => this.plugin.saveChatHistory(h),
        scheduleRender: () => this.scheduleRender(),
        forceRefresh: () => this.forceRefresh(),
        cachedTargetCal: this._cachedTargetCal,
        dailyMessages: this.dailyMessages,
        isDailyThinking: this.isDailyThinking,
        streamingReply: this.streamingReply,
        persistChatHistory: () => this.persistChatHistory(),
      };

      if (sc.chat    !== false) await this.renderCardSafe(grid, "ButlerChat",  "words",  () => new ButlerChatCard(grid, ctx).render());
      if (sc.tracker !== false) await this.renderCardSafe(grid, "MealTracker", "focus",  () => Promise.resolve(new MealTrackerCard(grid, ctx).render()));
      if (sc.diet    !== false) await this.renderCardSafe(grid, "DietGuide",   "study",  () => new DietGuideCard(grid, ctx).render());
      if (sc.tasks   !== false) await this.renderCardSafe(grid, "Tasks",       "tasks",  () => new TasksCard(grid, ctx).render());
      if (sc.pantry  !== false) await this.renderCardSafe(grid, "Pantry",      "pantry", () => new PantryCard(grid, ctx).render());
    } finally {
      this._isRenderingLocked = false;
    }
  }

  // ══════════════════════════════════════════════════════
  //  Museum Desk 12列卡片渲染引擎
  // ══════════════════════════════════════════════════════

  card(parent: HTMLElement, area: string, title: string, actionText: string, action?: () => void): HTMLElement {
    const card = parent.createDiv({ cls: `museum-live-card area-${area}` });
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

  //  Museum Desk 辅助时钟与日历计算引擎
  // ══════════════════════════════════════════════════════

  heroDisplay(date: Date): { label: string; value: string } {
    if (this.heroMode === "week") {
      return { label: `${date.getFullYear()}年`, value: `本年第 ${this.isoWeek(date)} 周` };
    }
    if (this.heroMode === "month") {
      return { label: `${date.getFullYear()}年`, value: date.toLocaleString("zh-CN", { month: "long" }) };
    }
    if (this.heroMode === "year") {
      return { label: "当前年份", value: `${date.getFullYear()}` };
    }
    return {
      label: `${date.getMonth() + 1}月${date.getDate()}日  星期${"日一二三四五六"[date.getDay()]!}`,
      value: this.formatClock(date)
    };
  }

  isoWeek(date: Date): number {
    const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = current.getUTCDay() || 7;
    current.setUTCDate(current.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
    return Math.ceil((((current.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  }

  formatClock(date: Date): string {
    return date.toLocaleTimeString("zh-CN", { hour12: false });
  }

}
