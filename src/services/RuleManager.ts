// src/services/RuleManager.ts

import { App, TFile } from "obsidian";

export class RuleManager {
  private app: App;
  private rulePath = "Diet/AI规范约束与纠错库.md";

  constructor(app: App) {
    this.app = app;
  }

  /**
   * 获取所有纠错规范与铁律文本
   */
  async getRules(): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.rulePath);
    if (file instanceof TFile) {
      return await this.app.vault.read(file);
    }
    // 若文件不存在，创建默认规范库
    const defaultText = `---
type: nutri-rules
tags: [nutri-rules, permanent-memory]
---
# 🛡️ PantryFin AI 规范约束与永久纠错指令库

> [!IMPORTANT]
> 本文件保存用户给出的所有铁律、偏好禁忌与纠错指令。**AI 在任何时候必须 100% 最高优先级严格遵守！**

## 🚨 用户永久铁律 (最高优先级)
- [基础规范] 每道菜必须标明具体食材克重。
- [基础规范] 优先消耗临期急需消耗的库存。
`;
    try {
      await this.app.vault.create(this.rulePath, defaultText);
    } catch {
      // 忽略并发冲突
    }
    return defaultText;
  }

  /**
   * 添加食材疲劳黑名单（带过期时间）
   */
  async addFatigueRule(ingredient: string, days: number = 5): Promise<void> {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    const expStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth()+1).padStart(2,"0")}-${String(targetDate.getDate()).padStart(2,"0")}`;
    const newEntry = `- [疲劳屏蔽 · 截至 ${expStr}] 用户反馈近期吃腻了【${ingredient}】，在此日期之前绝对禁止在任何三餐食谱中推荐该食材！`;
    // 直接写入文件，不经过 addRule（避免被添加 [纠错铁律] 前缀破坏正则匹配）
    let content = await this.getRules();
    if (content.includes("## 🚨 用户永久铁律")) {
      content = content.replace("## 🚨 用户永久铁律 (最高优先级)\n", `## 🚨 用户永久铁律 (最高优先级)\n${newEntry}\n`);
    } else {
      content += `\n## 🚨 用户永久铁律 (最高优先级)\n${newEntry}\n`;
    }
    const file = this.app.vault.getAbstractFileByPath(this.rulePath);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    }
  }

  /** 解析生效中的吃腻屏蔽清单 */
  async getActiveFatigueRules(): Promise<Array<{ rawLine: string; ingredient: string; expireDate: string }>> {
    const content = await this.getRules();
    const regex = /^-\s*(?:\[[^\]]+\]\s*)*\[疲劳屏蔽\s*·\s*截至\s*(\d{4}-\d{2}-\d{2})\]\s*用户反馈近期吃腻了【([^】]+)】/;
    return content.split("\n")
      .map(line => line.match(regex))
      .filter((m): m is RegExpExecArray => !!m && !!m[1] && !!m[2])
      .map(m => ({ rawLine: m.input!, ingredient: m[2]!, expireDate: m[1]! }));
  }

  /** 删除指定规则行（一键解除屏蔽） */
  async removeRuleLine(rawLine: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.rulePath);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const updated = content.split("\n").filter(l => l.trim() !== rawLine.trim()).join("\n");
    await this.app.vault.modify(file, updated);
  }

  /**
   * 追加永久铁律纠错指令
   */
  async addRule(ruleSentence: string): Promise<void> {
    const cleanRule = ruleSentence.replace(/^(?:纠正|纠错|切记|以后切勿|重申|铁律|严禁|必须遵守|规定|规矩)[一下是个：:\s]*/g, "").trim();
    if (!cleanRule) return;

    let content = await this.getRules();
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const newEntry = `- [纠错铁律 · ${dateStr}] ${cleanRule}`;

    if (content.includes("## 🚨 用户永久铁律")) {
      content = content.replace("## 🚨 用户永久铁律 (最高优先级)\n", `## 🚨 用户永久铁律 (最高优先级)\n${newEntry}\n`);
    } else {
      content += `\n## 🚨 用户永久铁律 (最高优先级)\n${newEntry}\n`;
    }

    const file = this.app.vault.getAbstractFileByPath(this.rulePath);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    }
  }
}
