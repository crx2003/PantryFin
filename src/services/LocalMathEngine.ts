// src/services/LocalMathEngine.ts

import { App, TFile, Notice } from "obsidian";
import { PantryParser } from "./PantryParser";
import { RuleManager } from "./RuleManager";

export interface InterceptResult {
  handled: boolean;
  reply?: string;
  triggerPlan?: boolean;
}

export class LocalMathEngine {
  private app: App;
  private pantryParser: PantryParser;
  private ruleManager: RuleManager;

  constructor(app: App, pantryParser: PantryParser, ruleManager: RuleManager) {
    this.app = app;
    this.pantryParser = pantryParser;
    this.ruleManager = ruleManager;
  }

  /**
   * 本地确定性指令拦截引擎：优先识别并执行数学计算与永久铁律，跳过 LLM 幻觉
   */
  async tryIntercept(userInput: string, pantryPath: string, profilePath: string): Promise<InterceptResult> {
    const text = userInput.trim();

    // ── 1. 永久纠错与铁律规范拦截 ──
    if (/纠正|纠错|切记|以后切勿|重申|铁律|严禁|切记不可|必须遵守|规定|永远不要|规矩是/.test(text)) {
      await this.ruleManager.addRule(text);
      new Notice("🛡️ 已追加至【AI规范约束与纠错库】！");
      return {
        handled: true,
        reply: `🛡️ [确定性内核拦截] 您的纠错指令已存入《AI规范约束与纠错库》，AI将在生成食谱时最高优先级时刻遵守：\n"${text}"`,
        triggerPlan: text.includes("菜单") || text.includes("食谱")
      };
    }

    // ── 2. 确定性食材消耗扣减拦截 ──
    // 匹配如："吃了一块鸡胸肉约150克" 或 "中午吃了150g牛肉" 或 "消耗了200克牛奶"
    const consumeReg1 = /(?:吃|喝|消耗|干|用|干了|吃掉|消耗掉)[了过]?\s*(?:约|大概)?\s*(\d+(?:\.\d+)?)\s*[克gG毫升mlML斤两公斤碗]\s*([\u4e00-\u9fa5]{1,8})/;
    const consumeReg2 = /(?:吃|喝|消耗|干|用|干了|吃掉|消耗掉)[了过]?\s*([\u4e00-\u9fa5]{1,8}?)\s*(?:约|大概|共)?\s*(\d+(?:\.\d+)?)\s*[克gG毫升mlML斤两公斤碗]/;

    const cMatch = text.match(consumeReg1) || text.match(consumeReg2);
    if (cMatch) {
      let amountNum = parseFloat(cMatch[1]!);
      let nameStr = cMatch[2]!.trim();
      if (isNaN(amountNum)) {
        amountNum = parseFloat(cMatch[2]!);
        nameStr = cMatch[1]!.trim();
      }

      if (!isNaN(amountNum) && nameStr) {
        // 清理名称前缀如"约"、"一块"等
        nameStr = nameStr.replace(/^(?:一块|一个|约|大概|一点)/, "");
        // 量词转换: 斤→500g, 两→50g, 公斤→1000g, 碗→200g
        const unitChar = cMatch[0] && cMatch[0].match(/[斤两公斤碗]/);
        if (unitChar) {
          const conv: Record<string, number> = { '斤': 500, '两': 50, '公斤': 1000, '碗': 200 };
          amountNum = (conv[unitChar[0]] || 1) * amountNum;
        }
        const { warnings } = await this.pantryParser.deductStock(pantryPath, [{ name: nameStr, amount_g: amountNum }]);
        let replyMsg = `⚡ [确定性内核] 实时库仓计算完毕！已扣减库存：**${nameStr}** (${amountNum}g)`;
        if (warnings && warnings.length > 0) {
          replyMsg += `\n\n⚠️ **触发低库存预警**：\n${warnings.join("\n")}`;
        }
        return { handled: true, reply: replyMsg };
      }
    }

    // ── 3. 确定性买菜采购录入拦截 ──
    // 匹配如："买了500克牛肉"、"买了一升牛奶"、"采购了鸡蛋10枚"、"买了2瓶酱油"
    const buyReg1 = /(?:买|采购|进货)[了入回]?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十半])\s*(克|g|千克|kg|公斤|斤|两|升|L|l|毫升|ml|枚|个|瓶|袋|颗|块|片)?\s*([一-龥]{1,8})/;
    const buyReg2 = /(?:买|采购|进货)[了入回]?\s*([一-龥]{1,8}?)\s*(\d+(?:\.\d+)?)\s*(克|g|千克|kg|公斤|斤|两|升|L|l|毫升|ml|枚|个|瓶|袋|颗|块|片)/;

    const CN_NUM: Record<string, number> = { "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "半": 0.5 };
    const UNIT_ALIAS: Record<string, string> = { "克": "g", "千克": "kg", "毫升": "ml" };

    const bMatch = text.match(buyReg1) || text.match(buyReg2);
    if (bMatch) {
      let qtyNum: number;
      let nameStr: string;
      let unit = "g";

      const g1 = bMatch[1]!;
      const g2 = bMatch[2] ?? "";
      const g3 = bMatch[3] ?? "";

      if (/^\d/.test(g1) || CN_NUM[g1]) {
        qtyNum = CN_NUM[g1] ?? parseFloat(g1);
        unit = UNIT_ALIAS[g2] || g2 || "g";
        nameStr = g3.trim();
      } else {
        nameStr = g1.trim();
        qtyNum = parseFloat(g2);
        unit = UNIT_ALIAS[g3] || g3 || "g";
      }

      if (!isNaN(qtyNum) && nameStr) {
        nameStr = nameStr.replace(/^(?:一些|大概|约)/, "");
        await this.pantryParser.manualAddOrMergeItem(pantryPath, "食材", nameStr, `${qtyNum}${unit}`);
        return {
          handled: true,
          reply: `🛒 [确定性内核] 食材采购已自动合并：**${nameStr}** (+${qtyNum}${unit})`
        };
      }
    }    // ── 4. 确定性体重指标同步拦截 ──
    const weightReg = /体重.*?[到为是约称称得称了]\s*(\d+(?:\.\d+)?)/;
    const wMatch = text.match(weightReg);
    if (wMatch) {
      const wVal = parseFloat(wMatch[1]!);
      if (!isNaN(wVal) && wVal > 20 && wVal < 200) {
        const prFile = this.app.vault.getAbstractFileByPath(profilePath);
        if (prFile instanceof TFile) {
          let prText = await this.app.vault.read(prFile);
          const reg = /(weight_kg:\s*)[^\r\n]+/;
          if (reg.test(prText)) {
            prText = prText.replace(reg, `$1${wVal}`);
          } else {
            prText = prText.replace("body:\n", `body:\n  weight_kg: ${wVal}\n`);
          }
          await this.app.vault.modify(prFile, prText);
          new Notice("⚖️ 体重已更新");
          return {
            handled: true,
            reply: `⚖️ [确定性内核] 个人健康底层档案同步成功！当前体重更新为：**${wVal} kg**`
          };
        }
      }
    }

    // 未匹配本地确定性拦截规则，交由后续 LLM 处理
    return { handled: false };
  }
}
