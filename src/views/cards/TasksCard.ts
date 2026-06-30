import { Notice, TFile } from "obsidian";
import { BaseCard } from "./BaseCard";

export class TasksCard extends BaseCard {
  private taskDescription(text: string): string {
    return text
      .replace(/#task\b/g, "")
      .replace(/\s*[📅⏳🛫✅➕🔁]\s*[^📅⏳🛫✅➕🔁#]+/g, " ")
      .replace(/\s*[⏫🔺🔼🔽⏬]\s*/g, " ")
      .replace(/#[^\s#]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async render(): Promise<void> {
    const card = this.createCard("tasks", "📝 今日待办", "+");

    let addMode = false;
    const headerBtn = card.querySelector(".museum-live-card-header button");
    if (headerBtn) {
      headerBtn.addEventListener("click", () => {
        if (addMode) return;
        addMode = true;
        const inputRow = card.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:6px;" } });
        const input = inputRow.createEl("input", {
          type: "text",
          placeholder: "输入待办，回车保存...",
          attr: { style: "flex:1;padding:4px 8px;border:1px solid var(--nd-accent);border-radius:4px;font-size:13px;background:var(--nd-card-bg);color:var(--nd-text);outline:none;" }
        });
        let saved = false;
        const saveTask = async () => {
          if (saved) return;
          saved = true;
          const text = input.value.trim();
          inputRow.remove();
          addMode = false;
          if (!text) return;
          const today = this.context.todayKey();
          const taskPath = "学习记录/task 命令面板/未命名.md";
          const file = this.context.app.vault.getAbstractFileByPath(taskPath);
          if (file instanceof TFile) {
            await this.context.app.vault.append(file, `\n- [ ] ${text} 📅 ${today}`);
          } else {
            const dir = taskPath.substring(0, taskPath.lastIndexOf("/"));
            if (dir && !this.context.app.vault.getAbstractFileByPath(dir)) {
              await this.context.app.vault.createFolder(dir);
            }
            await this.context.app.vault.create(taskPath, `# 待办\n\n- [ ] ${text} 📅 ${today}\n`);
          }
          new Notice("✅ 待办已添加");
          this.context.scheduleRender();
        };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveTask(); } });
        input.addEventListener("blur", () => { saveTask(); });
        input.focus();
      });
    }

    const tasks = await this.context.findOpenTasks(6);
    if (tasks && tasks.length > 0) {
      for (const task of tasks) {
        const row = card.createDiv({ cls: "museum-task-row" });
        const input = row.createEl("input", { type: "checkbox" });
        row.createSpan({ text: this.taskDescription(task.text) });
        input.addEventListener("change", async () => {
          await this.context.completeTask(task);
          new Notice("任务已完成");
          this.context.scheduleRender();
        });
      }
    } else {
      card.createEl("p", { cls: "museum-empty", text: "暂无待办" });
    }
  }
}
