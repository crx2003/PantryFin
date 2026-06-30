// src/scheduler/CronScheduler.ts

import { Notice } from "obsidian";

export class CronScheduler {
  private checkIntervalId: number | null = null;
  private scheduledTime: string;            // 格式 "HH:MM"，如 "06:30"
  private graceWindowMinutes: number;       // 宽容窗口（分钟）
  private lastTriggeredDate: string | null; // 上次触发日期，防重复
  private onTrigger: () => Promise<void>;   // 触发时执行的回调
  private hasPlanForToday: () => boolean;   // 检查今日计划是否已存在

  constructor(options: {
    scheduledTime: string;
    graceWindowMinutes?: number;
    onTrigger: () => Promise<void>;
    hasPlanForToday: () => boolean;
  }) {
    this.scheduledTime = options.scheduledTime;
    this.graceWindowMinutes = options.graceWindowMinutes ?? 120; // 默认 2 小时
    this.onTrigger = options.onTrigger;
    this.hasPlanForToday = options.hasPlanForToday;
    this.lastTriggeredDate = null;
  }

  /**
   * 启动调度器。返回 interval ID 供 registerInterval 使用。
   */
  start(): number {

    // 立即执行一次检查（处理 Obsidian 晚于触发时刻启动的情况）
    this.check();

    // 每 60 秒检查一次
    const intervalId = window.setInterval(() => {
      this.check();
    }, 60 * 1000);

    this.checkIntervalId = intervalId;
    return intervalId;
  }

  /**
   * 更新触发时间（用户在设置面板修改后调用）。
   */
  updateScheduledTime(newTime: string): void {
    this.scheduledTime = newTime;
  }

  /**
   * 核心检查逻辑：判断当前时刻是否应该触发。
   */
  private async check(): Promise<void> {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

    // ── 防重复：今天已经触发过了 ──
    if (this.lastTriggeredDate === todayStr) {
      return;
    }

    // ── 防重复：今天的菜单已经存在（可能是手动生成的）──
    if (this.hasPlanForToday()) {
      this.lastTriggeredDate = todayStr;
      return;
    }

    // ── 解析目标触发时间 ──
    const [targetHour, targetMinute] = this.scheduledTime
      .split(":")
      .map(Number);
    if (targetHour === undefined || targetMinute === undefined) {
      console.error(
        `PantryFin Scheduler: 无效的触发时间格式 "${this.scheduledTime}"`
      );
      return;
    }

    // 构建今日的目标触发时刻
    const targetTime = new Date(now);
    targetTime.setHours(targetHour, targetMinute, 0, 0);

    // 计算当前时间与目标时刻的差值（分钟）
    const diffMinutes = (now.getTime() - targetTime.getTime()) / (1000 * 60);

    // ── 判断是否在触发窗口内 ──
    if (diffMinutes >= 0 && diffMinutes <= this.graceWindowMinutes) {
      this.lastTriggeredDate = todayStr;
      new Notice(
        `🐟 PantryFin: 定时任务触发，正在自动生成今日饮食计划...`
      );

      try {
        await this.onTrigger();
      } catch (err) {
        console.error("PantryFin Scheduler: 触发执行失败:", err);
        this.lastTriggeredDate = null;
      }
    }
  }
}
