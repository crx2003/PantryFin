import { Platform } from "obsidian";
import { BaseCard } from "./BaseCard";

export class ButlerChatCard extends BaseCard {
  async render(): Promise<void> {
    const card = this.createCard("words", "💬 智能膳食 AI 管家 (纯净对话)", "");

    const historyEl = card.createDiv({ cls: "nutri-daily-history" });
    if (this.context.dailyMessages.length === 0 && !this.context.streamingReply) {
      const welcome = historyEl.createDiv({ cls: "nutri-daily-msg nutri-daily-ai" });
      const strong = welcome.createEl("strong", { text: "🤖 【智能膳食管家】" });
      strong.setCssStyles({ color: "var(--nd-accent)" });
      welcome.createEl("br");
      welcome.appendChild(activeDocument.createTextNode("您好！我是您的 AI 营养专属顾问（已接入 DeepSeek 引擎）。您可以对我想说任何话，例如："));
      welcome.createEl("br");
      welcome.appendChild(activeDocument.createTextNode("• \"我刚吃了 200g 鸡胸肉和一碗米饭，帮我记录并计算热量\""));
      welcome.createEl("br");
      welcome.appendChild(activeDocument.createTextNode("• \"帮我定制一份适合下周的低卡减脂食谱\""));
      welcome.createEl("br");
      welcome.appendChild(activeDocument.createTextNode("• \"我买了一斤西红柿和两块豆腐，记入库存\""));
    }
    const appendLines = (container: HTMLElement, content: string) => {
      content.split("\n").forEach((line, idx) => {
        if (idx > 0) container.createEl("br");
        container.appendChild(activeDocument.createTextNode(line));
      });
    };
    for (const m of this.context.dailyMessages) {
      const b = historyEl.createDiv({ cls: `nutri-daily-msg nutri-daily-${m.sender}` });
      appendLines(b, m.text);
    }
    if (this.context.streamingReply) {
      const b = historyEl.createDiv({ cls: "nutri-daily-msg nutri-daily-ai streaming-cursor" });
      appendLines(b, this.context.streamingReply.text);
    } else if (this.context.isDailyThinking) {
      historyEl.createDiv({ cls: "nutri-daily-msg nutri-daily-ai nutri-thinking", text: "🤖 常驻终端推演中..." });
    }
    historyEl.scrollTop = historyEl.scrollHeight;

    const inputRow = card.createDiv({ cls: "nutri-agy-input-row" });
    // P0 移动端: Enter 直接发送，Shift+Enter 换行
    const placeholderText = Platform.isMobile
      ? "向 AI 管家下达指令 (Enter 发送, Shift+Enter 换行)..."
      : "向 AI 管家下达指令：记录热量 / 调整计划 / 买菜入库 (Cmd+Enter 发送)...";
    const textarea = inputRow.createEl("textarea", {
      placeholder: this.context.isDailyThinking ? "AI 正在思考生成中..." : placeholderText,
      cls: "nutri-agy-textarea",
    });
    textarea.rows = Platform.isMobile ? 2 : 1;
    if (this.context.isDailyThinking) {
      textarea.disabled = true;
    }

    const sendBtn = inputRow.createEl("button", {
      text: "↑",
      cls: "nutri-agy-send-btn",
      title: Platform.isMobile ? "发送 (Enter)" : "发送 (Cmd+Enter)",
    });
    if (this.context.isDailyThinking) {
      sendBtn.disabled = true;
    }

    const sendDaily = async () => {
      const text = textarea.value.trim();
      if (!text || this.context.isDailyThinking) return;

      textarea.value = "";
      textarea.setCssStyles({ height: "auto" });
      this.context.dailyMessages.push({ sender: "user", text });
      this.context.isDailyThinking = true;
      this.context.scheduleRender();
      this.context.streamingReply = { text: "思考推演中..." };
      this.context.scheduleRender();

      // P0 移动端: 发送后滚动确保可见
      if (Platform.isMobile) {
        historyEl.scrollIntoView({ behavior: "smooth", block: "end" });
      }

      const reply = await this.context.handleDailyAgentCommand(text, (chunkText: string) => {
        if (this.context.streamingReply) {
          this.context.streamingReply.text = chunkText;
          this.context.scheduleRender();
        }
      });

      this.context.isDailyThinking = false;
      this.context.streamingReply = null;
      this.context.dailyMessages.push({ sender: "ai", text: reply ?? "❌ 后台推演异常" });
      this.context.persistChatHistory();
      this.context.scheduleRender();
    };

    textarea.addEventListener("input", () => {
      textarea.setCssStyles({ height: "auto" });
      textarea.setCssStyles({ height: `${Math.min(100, textarea.scrollHeight)}px` });
    });
    sendBtn.addEventListener("click", sendDaily);
    textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      // P0 移动端: Enter 发送 (非 Cmd/Ctrl), Shift+Enter 换行
      // 桌面端: Cmd+Enter / Ctrl+Enter 发送
      if (Platform.isMobile) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendDaily();
        }
      } else {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          sendDaily();
        }
      }
    });
  }
}
