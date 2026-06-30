// src/services/SubagentRegistry.ts
//
// 可注册子代理路由表，替换硬编码的 if-else 意图路由。
// 借鉴 obsidian-react-components 的命名空间组件注册模式。

export interface SubagentDefinition {
  /** 子代理唯一标识 */
  name: string;
  /** 意图匹配正则数组，任一匹配即触发 */
  patterns: RegExp[];
  /** 注入到 AI prompt 的任务指令模板 */
  instruction: string;
  /** 优先级（数值越大越优先），默认 0 */
  priority?: number;
}

export class SubagentRegistry {
  private agents: SubagentDefinition[] = [];
  private defaultAgent: SubagentDefinition;

  constructor(defaultAgent: SubagentDefinition) {
    this.defaultAgent = defaultAgent;
  }

  /** 注册一个子代理 */
  register(agent: SubagentDefinition): void {
    // 去重：同名代理覆盖
    const idx = this.agents.findIndex(a => a.name === agent.name);
    if (idx >= 0) {
      this.agents[idx] = agent;
    } else {
      this.agents.push(agent);
    }
    // 按优先级降序排列
    this.agents.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /** 注销一个子代理 */
  unregister(name: string): void {
    this.agents = this.agents.filter(a => a.name !== name);
  }

  /** 根据用户输入匹配最佳子代理 */
  route(userInput: string): SubagentDefinition {
    for (const agent of this.agents) {
      for (const pattern of agent.patterns) {
        if (pattern.test(userInput)) {
          return agent;
        }
      }
    }
    return this.defaultAgent;
  }

  /** 列出所有已注册的子代理 */
  list(): ReadonlyArray<SubagentDefinition> {
    return this.agents;
  }
}

/** 创建 PantryFin 预置的子代理路由表 */
export function createDefaultRegistry(): SubagentRegistry {
  const registry = new SubagentRegistry({
    name: "健康顾问专家",
    patterns: [],
    instruction: "任务规则：专注于专业营养解答、卡路里计算原理分析与日常贴心建议。语言简洁精辟，富有同理心。",
    priority: 0,
  });

  registry.register({
    name: "食谱规划专家",
    patterns: [/食谱|安排|吃什么|菜单|计划|做法|增肌餐|减脂餐|推荐菜/],
    instruction: "任务规则：严格遵循 HowToCook 程序员做饭指南极客规范（零模糊词汇、精确到克/毫升、带终止条件断言），为用户结合当前库存量身规划建议。若用户明确要求生成或重置每日菜单，必须在 JSON 设置 trigger_plan: true。",
    priority: 20,
  });

  registry.register({
    name: "核算打卡专家",
    patterns: [/吃了|买|补货|扣|喝|记录|入库|体重|身高/],
    instruction: `任务规则：
1. 若用户买了菜，在 JSON 的 add_items 给出 [{"category": "肉类", "name": "牛肉", "quantity": "600g", "expiry": "2026-07-03"}]。
2. 若用户吃了菜或要求扣减库存，在 consume_items 给出 [{"name": "鸡胸肉", "amount_g": 150}]。
3. 若用户更新了体重/身高，在 update_profile 给出。
4. 语言极致精简高效，确认扣减与入库结果。`,
    priority: 15,
  });

  return registry;
}
