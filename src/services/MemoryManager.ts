// src/services/MemoryManager.ts

import { App, TFile } from "obsidian";

export class MemoryManager {
  private app: App;
  private memoryFolder: string = "Diet/Memory";

  constructor(app: App) {
    this.app = app;
  }

  /**
   * 获取月度记忆笔记路径：Diet/Memory/YYYY-MM.md
   */
  getMonthlyMemoryPath(dateStr?: string): string {
    const targetDate = dateStr ? new Date(dateStr) : new Date();
    const ym = `${targetDate.getFullYear()}-${String(targetDate.getMonth()+1).padStart(2,"0")}`;
    return `${this.memoryFolder}/${ym}.md`;
  }

  /**
   * 向月度记忆笔记中追记一条交互或方案记忆
   */
  async appendMemory(summary: string, dateStr?: string): Promise<void> {
    const vault = this.app.vault;
    const d = dateStr ? new Date(dateStr) : new Date();
    const todayStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const filePath = this.getMonthlyMemoryPath(todayStr);

    let content = "";
    const file = vault.getAbstractFileByPath(filePath);

    if (file instanceof TFile) {
      content = await vault.read(file);
    } else {
      // 自动创建记忆目录
      if (!vault.getAbstractFileByPath(this.memoryFolder)) {
        try { await vault.createFolder(this.memoryFolder); } catch {}
      }
      const ym = todayStr.slice(0, 7);
      content = `# 🧠 PantryFin 智能膳食月度进化记忆库 (${ym})\n\n> 本文档由系统自动健全维护，保证 AI 永久记住给出的每一个方案与用户的每次反馈。\n\n`;
    }

    const timeStr = new Date().toTimeString().slice(0, 8);
    const logItem = `- [${timeStr}] ${summary}\n`;

    const regHeader = new RegExp(`(##\\s+${todayStr})`);
    if (regHeader.test(content)) {
      // 追加在对应日期段下
      const parts = content.split(`## ${todayStr}`);
      const after = parts[1]!;
      const nextHeaderIdx = after.indexOf("\n## ");
      if (nextHeaderIdx !== -1) {
        content = parts[0] + `## ${todayStr}` + after.slice(0, nextHeaderIdx) + logItem + after.slice(nextHeaderIdx);
      } else {
        content = content.trimEnd() + "\n" + logItem;
      }
    } else {
      content = content.trimEnd() + `\n\n## ${todayStr}\n` + logItem;
    }

    if (file instanceof TFile) {
      await vault.modify(file, content);
    } else {
      await vault.create(filePath, content);
    }
  }

  /**
   * 窗口裁剪机制：读取最近 N 天的记忆切片，大幅减少 AI 阅读推演时间
   */
  async getRecentMemorySlice(days: number = 3): Promise<string> {
    const filePath = this.getMonthlyMemoryPath();
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return "暂无历史记忆数据。";

    const content = await this.app.vault.read(file);
    const sections = content.split("\n## ").filter(s => !s.startsWith("# 🧠"));
    if (sections.length === 0) return "近期无特殊变动记忆。";

    const recent = sections.slice(-days).map(s => `## ${s.trim()}`).join("\n\n");
    return recent;
  }

  /**
   * 获取当月全量记忆文本（用户明确发问历史时加载）
   */
  async getFullMemory(): Promise<string> {
    const filePath = this.getMonthlyMemoryPath();
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return "当月尚无记忆库记录。";
    return await this.app.vault.read(file);
  }
}
