// src/api.ts
//
// Zotero Better Notes 风格 API 门面。
// 所有外部代码（DashboardView、命令、Ribbon）通过此门面访问插件能力。
// 内部模块重构不影响外部调用方。

import type NutriAgentPlugin from "./main";

export interface NutriAgentAPI {
    // ── 设置 ──
    readonly settings: NutriAgentPlugin["settings"];

    // ── 工具方法 ──
    todayKey(date?: Date): string;

    // ── 食谱生成 ──
    generateDailyPlan(date?: string): Promise<void>;
    acceptMealPlanAndDeduct(dateStr: string, mealLabel?: string): Promise<void>;
    revertMealPlanDeduction(dateStr: string, mealLabel?: string): Promise<void>;

    // ── AI 通信 ──
    handleDailyAgentCommand(userInput: string): Promise<string | null>;

    // ── 库存 ──
    pantryParser: NutriAgentPlugin["pantryParser"];

    // ── 导航 ──
    openPath(path: string, sourcePath?: string): Promise<void>;
    openFolder(path: string): Promise<void>;

    // ── 任务 ──
    findOpenTasks(limit?: number): Promise<any[]>;
    completeTask(task: any): Promise<void>;

    // ── 同步 ──
    syncMasterCenterNote(): Promise<void>;

    // ── 建档 ──

    // ── 聊天持久化 ──
    saveChatHistory(history: Record<string, Array<{ sender: string; text: string }>>): Promise<void>;

    // ── Hooks 事件总线 ──
    hooks: Hooks;
}

// ── 轻量 Hooks 事件总线 ──────────────────────────
type HookCallback = (...args: any[]) => void;

export class Hooks {
    private listeners: Map<string, Set<HookCallback>> = new Map();

    on(event: string, cb: HookCallback): void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(cb);
    }

    off(event: string, cb: HookCallback): void {
        this.listeners.get(event)?.delete(cb);
    }

    trigger(event: string, ...args: any[]): void {
        this.listeners.get(event)?.forEach(cb => {
            try { cb(...args); } catch (e) { console.warn(`[NutriAPI] Hook "${event}" 回调异常:`, e); }
        });
    }
}

// ── 工厂函数 ─────────────────────────────────────
export function createAPI(plugin: NutriAgentPlugin): NutriAgentAPI {
    const hooks = new Hooks();

    return {
        get settings() { return plugin.settings; },

        todayKey: (d) => plugin.todayKey(d),

        generateDailyPlan: (d) => plugin.generateDailyPlan(d),
        acceptMealPlanAndDeduct: (d, m) => plugin.acceptMealPlanAndDeduct(d, m),
        revertMealPlanDeduction: (d, m) => plugin.revertMealPlanDeduction(d, m),

        handleDailyAgentCommand: (u) => plugin.handleDailyAgentCommand(u),

        get pantryParser() { return plugin.pantryParser; },

        openPath: (p, s) => plugin.openPath(p, s),
        openFolder: (p) => plugin.openFolder(p),

        findOpenTasks: (l) => plugin.findOpenTasks(l),
        completeTask: (t) => plugin.completeTask(t),

        syncMasterCenterNote: () => plugin.syncMasterCenterNote(),
        saveChatHistory: (h) => plugin.saveChatHistory(h),

        hooks,
    };
}
