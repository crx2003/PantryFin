// src/services/AgyEngine.ts

import { Notice, requestUrl, Platform } from "obsidian";
import { UserProfile, PantryItem, AgyResponse, SingleMealResponse, ChatMessage } from "../models/types";

export class AgyEngine {
  private agyPath: string;
  private model: string | null;
  private timeoutSeconds: number;
  private skipPermissions: boolean;
  private aiProviderMode: 'api' | 'cli';
  private apiBaseUrl: string;
  private apiKey: string;
  private apiModel: string;
  private requestSeq = 0;  // 请求序列号，防止并发 IPC 文件冲突

  constructor(options: {
    agyPath?: string;
    model?: string | null;
    timeoutSeconds?: number;
    skipPermissions?: boolean;
    aiProviderMode?: 'api' | 'cli';
    apiBaseUrl?: string;
    apiKey?: string;
    apiModel?: string;
  } = {}) {
    this.agyPath = options.agyPath ?? "";
    this.model = options.model ?? null;
    this.timeoutSeconds = options.timeoutSeconds ?? 45;
    this.skipPermissions = options.skipPermissions ?? true;
    this.aiProviderMode = options.aiProviderMode ?? 'api';
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.deepseek.com';
    this.apiKey = options.apiKey ?? '';
    this.apiModel = options.apiModel ?? 'deepseek-v4-flash';
  }

  /** 热更新 API 配置（设置面板修改后调用，无需重启插件） */
  updateApiConfig(config: {
    apiBaseUrl?: string;
    apiKey?: string;
    apiModel?: string;
    aiProviderMode?: 'api' | 'cli';
  }): void {
    if (config.apiBaseUrl !== undefined) this.apiBaseUrl = config.apiBaseUrl;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey;
    if (config.apiModel !== undefined) this.apiModel = config.apiModel;
    if (config.aiProviderMode !== undefined) this.aiProviderMode = config.aiProviderMode;
  }

  /**
   * 调用 agy CLI 生成每日饮食计划。
   *
   * 执行流程：
   *   1. 组装结构化 Prompt（含用户档案 + 库存 + 约束规则）
   *   2. 通过 child_process.execFile 调用 agy -p "prompt"
   *   3. 捕获 stdout 原始输出
   *   4. 解析出 Markdown 正文 + JSON 库存扣减块
   */
  async generateMealPlan(
    profile: UserProfile,
    pantry: PantryItem[],
    date: string,
    memorySlice?: string,
    rulesText?: string
  ): Promise<AgyResponse | null> {
    // 1. 组装 Prompt
    const prompt = this.buildPrompt(profile, pantry, date, memorySlice, rulesText);

    // 2. 调用 agy CLI 或 API 直连
    const rawOutput = await this.callAI(prompt);
    if (!rawOutput) return null;

    // 3. 解析响应
    return this.parseResponse(rawOutput);
  }

  /** 通用底层 AI 执行通道，供日常聊天管家随时下单 */
  async executeRaw(prompt: string): Promise<string | null> {
    return this.callAI(prompt);
  }

  /** 使用预计算好的紧凑 Prompt 生成菜谱（配合 ContextPackager 使用） */
  async generateFromCompactPrompt(compactPrompt: string): Promise<AgyResponse | null> {
    const rawOutput = await this.callAI(compactPrompt);
    if (!rawOutput) return null;
    return this.parseResponse(rawOutput);
  }

  /** v4.2 单餐生成：返回 SingleMealResponse（无 shopping_advice） */
  async generateSingleMeal(compactPrompt: string): Promise<SingleMealResponse | null> {
    const rawOutput = await this.callAI(compactPrompt);
    if (!rawOutput) return null;
    return this.parseSingleMealResponse(rawOutput);
  }

  // ══════════════════════════════════════════════════════
  //  Prompt 模板工程
  // ══════════════════════════════════════════════════════

  private buildPrompt(
    profile: UserProfile,
    pantry: PantryItem[],
    date: string,
    memorySlice?: string,
    rulesText?: string
  ): string {
    // ── 序列化用户档案为可读文本 ──
    const profileText = [
      `身高: ${profile.body.height_cm} cm`,
      `体重: ${profile.body.weight_kg} kg`,
      `年龄: ${profile.body.age} 岁`,
      `性别: ${profile.body.gender === "male" ? "男" : "女"}`,
      `活动水平: ${this.translateActivityLevel(profile.body.activity_level)}`,
      `目标: ${this.translateGoalType(profile.goal.type)}`,
      `目标体重: ${profile.goal.target_weight_kg} kg`,
      `每周计划变化: ${profile.goal.weekly_rate_kg} kg`,
      `饮食风格: ${profile.preferences.dietary_style}`,
      profile.preferences.allergies.length > 0
        ? `过敏原: ${profile.preferences.allergies.join("、")}`
        : null,
      profile.preferences.dislikes.length > 0
        ? `不喜欢的食材: ${profile.preferences.dislikes.join("、")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    // ── 序列化食材库存为 Markdown 表格 ──
    const pantryHeader =
      "| 类别 | 名称 | 数量 | 采购日期 | 保质期 | 状态 |";
    const pantrySep =
      "| :--- | :--- | :--- | :--- | :--- | :--- |";
    const pantryRows = pantry
      .map(
        (item) =>
          `| ${item.category} | ${item.name} | ${item.quantity} | ${item.purchaseDate} | ${item.expiryDate} | ${item.priority} |`
      )
      .join("\n");
    const pantryTable =
      pantry.length > 0
        ? `${pantryHeader}\n${pantrySep}\n${pantryRows}`
        : "（库存为空，请提醒用户先采购食材）";

    const memBlock = memorySlice ? `\n## AI近期执行记忆与习惯反馈切片\n${memorySlice}\n` : "";
    const rulesBlock = rulesText ? `\n### 🚨 最高优先级用户铁律与纠错规范（必须100%严格绝对遵守）\n${rulesText}\n` : "";

    // ── 组装完整 Prompt ──
    return `你是一位专业的运动营养师与膳食规划 AI。请根据以下用户数据，为 ${date} 设计完整的一日三餐饮食计划。
${rulesBlock}
## 用户身体档案
${profileText}

## 当前食材库存
${pantryTable}
${memBlock}
## 规划约束（遵循程序员做饭指南 HowToCook 严谨规范）
1. 根据 Mifflin-St Jeor 公式计算 BMR，结合活动系数得出 TDEE，再依据目标（${this.translateGoalType(profile.goal.type)}）调整每日热量目标。
2. 严禁使用库存表中不存在的食材（基础调料如盐、生抽、橄榄油、胡椒粉除外）。
3. 优先消耗标记为"🔴 急需消耗"和"🟡 尽快消耗"的临期食材。
4. 【严禁模糊词汇】：彻底消灭“适量”、“少许”、“酌情”、“中量”等模糊描述！所有食材与调料必须严格量化到克 (g) 或毫升 (ml)（如：食用油 10ml，盐 3g）。
5. 【操作程序断言】：步骤描述中必须指明确切的时间参数（如等待 15 分钟）和清晰的步骤终止条件断言（如：直到筷子能轻松穿透、外表呈粘稠状态）。
6. 三大营养素（蛋白质、碳水、脂肪）需明确克数和占比。
7. 【勿强行消耗库存】：绝不要为了消耗库存而把毫不相关的食材强行凑杂在同一道菜中！不同菜肴应当使用不同且合理的食材子集，确保搭配符合真实中餐烹饪常识。
8. 【家庭厨房友好】：菜谱做法必须优先适配普通家庭厨房的设备与实操条件，严禁生成极其繁杂、需要专业设备或分子料理级别的米其林炫技做法。
9. 【极简基础配料】：除用户现有库存外，AI 额外推荐的辅助用料必须极度克制，严格限制在盐、糖、食用油、生抽、老抽、醋、葱、姜、蒜等最基本的家庭厨房常备调料之内。
${profile.preferences.allergies.length > 0 ? `10. 严禁使用以下过敏原食材: ${profile.preferences.allergies.join("、")}` : ""}
${profile.preferences.dislikes.length > 0 ? `11. 避免使用以下食材: ${profile.preferences.dislikes.join("、")}` : ""}

## 输出格式（必须严格按照以下极客模板）

# 🥗 ${date} 饮食设计安排

## 📊 今日营养代谢指标
- **基础代谢 (BMR)**: xxxx kcal（写出计算过程）
- **目标热量 (TDEE±)**: xxxx kcal
- **三大营养素目标**: 蛋白质 xxg (xx%) | 碳水 xxg (xx%) | 脂肪 xxg (xx%)

## 🍳 早餐 (预计 xxx kcal)
- **菜品名称与难度**: 比如：快手燕麦蛋饼 (预估难度: ★☆☆☆☆, 10分钟)
- **精确原料清单**: 燕麦片 50g, 鸡蛋 2 个 (约 100g), 牛奶 100ml, 盐 2g, 橄榄油 5ml
- **程序化操作步骤**: 
  1. 混合搅拌：将燕麦、牛奶与鸡蛋倒入碗中，慢速搅拌 2 分钟至完全融合。
  2. 热锅下油：平底锅倒入 5ml 橄榄油，中火加热 15 秒。
  3. 煎熟断言：倒入蛋液，中火静置煎制 2 分钟，直到表面蛋液凝固不再流动（终止条件断言），翻面继续煎制 1 分钟后出锅。

## 🥗 午餐 (预计 xxx kcal)
（同上极客格式：含精确原料清单与程序化操作步骤断言）

## 🌙 晚餐 (预计 xxx kcal)
（同上极客格式：含精确原料清单与程序化操作步骤断言）

## 💡 今日饮食小贴士
（一段针对用户目标的个性化建议）

---
最后，你必须输出一个纯 JSON 对象（不要用 \`\`\`json 包裹），格式如下：
{
  "markdown_content": "完整的 Markdown 菜谱正文",
  "consume": [{"name": "食材名称", "amount_g": 消耗克重数字}]
}`;
  }

  // ══════════════════════════════════════════════════════
  //  响应解析器
  // ══════════════════════════════════════════════════════

  private parseResponse(rawOutput: string): AgyResponse {
    const cleaned = this.stripAnsi(rawOutput);

    // 优先: 直接 JSON.parse（response_format: json_object 保证合法 JSON）
    try {
      const parsed = JSON.parse(cleaned);
      const shopping = Array.isArray(parsed.shopping_advice) ? parsed.shopping_advice
        : Array.isArray(parsed.shoppingAdvice) ? parsed.shoppingAdvice
        : Array.isArray(parsed.shopping) ? parsed.shopping
        : [];
      return {
        markdownContent: typeof parsed.markdown_content === "string"
          ? parsed.markdown_content
          : (typeof parsed.reply === "string" ? parsed.reply : cleaned),
        consume: Array.isArray(parsed.consume) ? parsed.consume : [],
        shopping_advice: shopping,
      };
    } catch {
      // 回退: 旧版 ```json 代码块提取（兼容 CLI 模式或不支持 json_object 的 API）
    }

    const jsonMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    let consume: AgyResponse["consume"] = [];
    let shoppingAdvice: string[] = [];

    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        consume = Array.isArray(parsed.consume) ? parsed.consume : [];
        shoppingAdvice = Array.isArray(parsed.shopping_advice)
          ? parsed.shopping_advice
          : [];
      } catch (err) {
        console.warn("NutriAgent: JSON 解析失败", err);
      }
    }

    let markdownContent = cleaned;
    if (jsonMatch) {
      const jsonBlockStart = cleaned.lastIndexOf("```");
      if (jsonBlockStart > 0) {
        markdownContent = cleaned.substring(0, jsonBlockStart).trimEnd();
      }
    }

    return { markdownContent, consume, shopping_advice: shoppingAdvice };
  }

  /** v4.2 解析单餐 AI 响应 → SingleMealResponse */
  private parseSingleMealResponse(rawOutput: string): SingleMealResponse {
    const cleaned = this.stripAnsi(rawOutput);

    // 优先: 直接 JSON.parse（response_format: json_object 保证合法 JSON）
    try {
      const parsed = JSON.parse(cleaned);
      return {
        markdownContent: typeof parsed.markdown_content === "string"
          ? parsed.markdown_content
          : (typeof parsed.reply === "string" ? parsed.reply : cleaned),
        consume: Array.isArray(parsed.consume) ? parsed.consume : [],
      };
    } catch {
      // 回退: ```json 代码块提取
    }

    const jsonMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    let consume: SingleMealResponse["consume"] = [];

    if (jsonMatch && jsonMatch[1]) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        consume = Array.isArray(parsed.consume) ? parsed.consume : [];
      } catch (err) {
        console.warn("NutriAgent: 单餐 JSON 解析失败", err);
      }
    }

    let markdownContent = cleaned;
    if (jsonMatch) {
      const jsonBlockStart = cleaned.lastIndexOf("```");
      if (jsonBlockStart > 0) {
        markdownContent = cleaned.substring(0, jsonBlockStart).trimEnd();
      }
    }

    return { markdownContent, consume };
  }

  // ══════════════════════════════════════════════════════
  //  工具方法
  // ══════════════════════════════════════════════════════

  private stripAnsi(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ""
    );
  }

  private translateActivityLevel(level: string): string {
    const map: Record<string, string> = {
      sedentary: "久坐不动（无运动）",
      light: "轻度活动（每周 1-3 天运动）",
      moderate: "中度活动（每周 3-5 天运动）",
      active: "高度活动（每周 6-7 天运动）",
      very_active: "专业运动员级别",
    };
    return map[level] ?? level;
  }

  private translateGoalType(type: string): string {
    const map: Record<string, string> = {
      fat_loss: "减脂",
      muscle_gain: "增肌",
      maintenance: "维持体重",
    };
    return map[type] ?? type;
  }

  // ══════════════════════════════════════════════════════
  //  AI 聊天采访建档引擎 (Chat Onboarding Interview)
  // ══════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════
  //  API 直连通道与在线诊断测试 (API Direct & Diagnostics)
  // ══════════════════════════════════════════════════════

  async testConnection(): Promise<{ success: boolean; msg: string }> {
    if (this.aiProviderMode !== 'api') {
      return { success: true, msg: "当前为 CLI 模式，将使用本地 agy 终端执行。" };
    }
    if (!this.apiKey) {
      return { success: false, msg: "请先在设置面板中填写 API Key！" };
    }
    const baseUrl = (this.apiBaseUrl || "https://api.deepseek.com").replace(/\/+$/, '') + "/chat/completions";
    try {
      const res = await requestUrl({
        url: baseUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.apiModel || "deepseek-v4-flash",
          messages: [{ role: "user", content: "你好" }],
          max_tokens: 10
        })
      });
      if (res.status === 200) {
        return { success: true, msg: "🎉 连接测试成功！云端 API 通信畅通无阻。" };
      } else {
        return { success: false, msg: `连接失败 HTTP ${res.status}: ${res.text.slice(0, 100)}` };
      }
    } catch (e: any) {
      return { success: false, msg: `网络通信异常 [HTTP ${e.status || 'Error'}]: ${e.message || e}` };
    }
  }

  private async callAI(prompt: string): Promise<string | null> {
    return this.callApi(prompt);
  }

  private async callApi(prompt: string, retries: number = 2): Promise<string | null> {
    const baseUrl = (this.apiBaseUrl || "https://api.deepseek.com").replace(/\/+$/, '') + "/chat/completions";
    try {
      const res = await requestUrl({
        url: baseUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.apiModel || "deepseek-v4-flash",
          messages: [
            { role: "system", content: "你是一位精通膳食管理、严格遵循 HowToCook 极客量化标准的 AI 营养管家。你必须始终输出合法的 JSON，markdown 内容放在 markdown_content 字段中。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.7,
          response_format: { type: "json_object" }  // 强制 JSON 输出，彻底消除正则解析
        })
      });
      if (res.status === 200) {
        const json = res.json;
        if (json && json.choices && json.choices.length > 0) {
          return json.choices[0].message.content;
        }
      }
      console.error("NutriAgent API Error:", res.status, res.text);
      new Notice(`AI 接口报错 [HTTP ${res.status}]: 请检查设置面板中的 API Key 与 URL`);
      return null;
    } catch (e: any) {
      // P2 移动端弱网容错: 指数退避重试 (1s, 2s)
      if (retries > 0 && Platform.isMobile) {
        const delayMs = (3 - retries) * 1000;
        console.warn(`[PantryFin] API request failed, retrying in ${delayMs}ms (${retries} retries left):`, e.message || e);
        await new Promise(r => setTimeout(r, delayMs));
        return this.callApi(prompt, retries - 1);
      }
      console.error("PantryFin API Request Exception:", e);
      new Notice(`AI 网络通信异常 [HTTP ${e.status || 'Error'}]: ${e.message || e}`);
      return null;
    }
  }

  /**
   * 支持 SSE 流式输出的安全请求引擎：移动端或网络跨域自动降级至 requestUrl
   */
  async callApiStreamSafe(
    prompt: string,
    onChunk: (text: string) => void,
    onComplete: (fullText: string) => void
  ): Promise<void> {
    // 如果是 CLI 模式或移动端环境，直接安全降级至 requestUrl
    if (this.aiProviderMode === "cli" || Platform.isMobile || typeof fetch !== "function") {
      const fullText = await this.executeRaw(prompt);
      const resText = fullText || "";
      const reply = ProgressiveJsonExtractor.extractReply(resText);
      if (reply) onChunk(reply);
      onComplete(resText);
      return;
    }

    try {
      // 流式路径: 逐步推送到 UI，完成后统一解析 JSON 执行指令
      await this._streamFromApi(prompt, onChunk, onComplete);
    } catch (err) {
      console.warn("[NutriAgent] SSE 流式请求异常或被浏览器 CORS 拦截，自动降级至 requestUrl:", err);
      const fullText = await this.executeRaw(prompt);
      const resText = fullText || "";
      const reply = ProgressiveJsonExtractor.extractReply(resText);
      if (reply) onChunk(reply);
      onComplete(resText);
    }
  }

  /** SSE 流式读取核心逻辑，与降级分支分离，便于单独测试 */
  private async _streamFromApi(
    prompt: string,
    onChunk: (text: string) => void,
    onComplete: (fullText: string) => void
  ): Promise<void> {
    const baseUrl = (this.apiBaseUrl || "https://api.deepseek.com").replace(/\/+$/, '') + "/chat/completions";
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.apiModel || "deepseek-v4-flash",
        messages: [
          { role: "system", content: "你是一位精通膳食管理、严格遵循 HowToCook 极客量化标准的 AI 营养管家。你必须始终输出合法的 JSON，markdown 内容放在 markdown_content 字段中。你的整个回复必须是一个完整的 JSON 对象，不要包含任何解释性文字。" },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        stream: true
        // stream 模式下不设置 response_format，JSON 约束由 system prompt 保证
      })
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullJsonBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const dataStr = trimmed.slice(6).trim();
          if (dataStr === "[DONE]") continue;
          try {
            const chunkObj = JSON.parse(dataStr);
            const content = chunkObj.choices?.[0]?.delta?.content || "";
            if (content) {
              fullJsonBuffer += content;
              const progressiveReply = ProgressiveJsonExtractor.extractReply(fullJsonBuffer);
              if (progressiveReply) {
                onChunk(progressiveReply);
              }
            }
          } catch { /* 忽略非 JSON 行（如注释） */ }
        }
      }
    }
    onComplete(fullJsonBuffer);
  }
  // ══════════════════════════════════════════════════════
  //  单菜谱限定上下文对话 (v4.0)
  // ══════════════════════════════════════════════════════

  /** 在单个食谱上下文中回答用户问题。移植自 Smart Recipe Gen getChatAssistantSystemPrompt */
  async conductRecipeChat(
    recipeName: string,
    ingredients: string,
    steps: string,
    userQuestion: string
  ): Promise<string | null> {
    const systemPrompt = `You are a helpful recipe assistant. You only respond to questions that are directly related to the following recipe:

Recipe Name: ${recipeName}
Ingredients: ${ingredients}
Instructions: ${steps}

You may provide useful suggestions about ingredient substitutions, dietary modifications, cooking techniques, tools, or serving advice — as long as they apply specifically to this recipe.

If the user asks about anything not related to this recipe — including general cooking topics, science, history, entertainment, or other off-topic subjects — politely decline and guide them back to questions about the recipe: ${recipeName}.`;

    const prompt = `${systemPrompt}

User question: ${userQuestion}

Provide a concise, helpful answer in Chinese (unless the user asks in English). Keep it under 150 words.`;

    return this.callAI(prompt);
  }
}

/**
 * 渐进式 JSON 提取器：从 SSE 碎片流中安全提取 reply 字段，通过补齐转义引号防截断
 */
export class ProgressiveJsonExtractor {
  static extractReply(buffer: string): string {
    try {
      const parsed = JSON.parse(buffer);
      if (parsed && typeof parsed.reply === "string") return parsed.reply;
    } catch {}

    const match = buffer.match(/"reply"\s*:\s*"/);
    if (!match || match.index === undefined) return "";

    const startIdx = match.index + match[0].length;
    let rawStr = "";
    let isEscaped = false;

    for (let i = startIdx; i < buffer.length; i++) {
      const char = buffer[i]!;
      if (isEscaped) {
        rawStr += char;
        isEscaped = false;
      } else if (char === '\\') {
        rawStr += char;
        isEscaped = true;
      } else if (char === '"') {
        break;
      } else {
        rawStr += char;
      }
    }

    if (rawStr.endsWith('\\')) {
      rawStr = rawStr.slice(0, -1);
    }

    try {
      return JSON.parse(`"${rawStr}"`);
    } catch {
      return rawStr
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
    }
  }
}

