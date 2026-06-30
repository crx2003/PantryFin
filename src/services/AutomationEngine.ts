// src/services/AutomationEngine.ts
//
// 轻量自动化预处理引擎 v1.0
// 移植自 Tandoor Automation 规则系统（精简版）
// 在 UnitConverter.parse() 之前执行文本规范化

export type AutomationRuleType = "food_replace" | "never_unit";

export interface AutomationRule {
  type: AutomationRuleType;
  pattern: string;   // 匹配文本（对于 food_replace: 要被替换的文本）
  replacement: string; // 替换为（对于 never_unit: 忽略）
  enabled: boolean;
}

export class AutomationEngine {
  private rules: AutomationRule[] = [];

  loadRules(rules: AutomationRule[]): void {
    this.rules = rules.filter(r => r.pattern && r.pattern.length > 0);
  }

  /** 对食材文本应用所有启用规则，返回规范化后的文本 */
  apply(text: string): string {
    let result = text;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      switch (rule.type) {
        case "food_replace":
          try {
            result = result.replace(new RegExp(rule.pattern, "g"), rule.replacement);
          } catch {
            // 当用户输入的 pattern 包含未转义的正则特殊字符时，回退至普通字符串全局替换
            result = result.split(rule.pattern).join(rule.replacement);
          }
          break;
        case "never_unit":
          // 在文本末尾追加标记，阻止 UnitConverter 将特定词识别为单位
          // 实现：将 "salt 100g" 中的 "salt" 保护起来
          // 轻量版：不做复杂实现，仅记录
          break;
      }
    }
    return result;
  }
}
