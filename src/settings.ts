// src/settings.ts

import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
  requestUrl,
} from "obsidian";
import type NutriAgentPlugin from "./main";
import type { AutomationRule } from "./services/AutomationEngine";
import { getFoodDatabase } from "./nutrition/FoodDatabase";

export class NutriAgentSettingTab extends PluginSettingTab {
  plugin: NutriAgentPlugin;

  constructor(app: App, plugin: NutriAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ══════════════════════════════════════════════════════
    //  数据文件路径配置
    // ══════════════════════════════════════════════════════
    new Setting(containerEl).setName("📁 数据文件路径").setHeading();

    new Setting(containerEl)
      .setName("身体档案路径")
      .setDesc("Profile.md 在 Vault 中的相对路径")
      .addText((text) =>
        text
          .setPlaceholder("Diet/Profile.md")
          .setValue(this.plugin.settings.profilePath)
          .onChange(async (value) => {
            this.plugin.settings.profilePath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("食材库存路径")
      .setDesc("Pantry.md 在 Vault 中的相对路径")
      .addText((text) =>
        text
          .setPlaceholder("Diet/Pantry.md")
          .setValue(this.plugin.settings.pantryPath)
          .onChange(async (value) => {
            this.plugin.settings.pantryPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("菜单输出目录")
      .setDesc("每日饮食计划 Markdown 文件的存放目录")
      .addText((text) =>
        text
          .setPlaceholder("Diet/Meal_Plans")
          .setValue(this.plugin.settings.mealPlanFolder)
          .onChange(async (value) => {
            this.plugin.settings.mealPlanFolder = value;
            await this.plugin.saveSettings();
          })
      );

    // ── 快捷创建模板按钮 ──
    new Setting(containerEl)
      .setName("创建模板文件")
      .setDesc("一键在 Vault 中创建 Profile.md 和 Pantry.md 初始模板")
      .addButton((button) =>
        button
          .setButtonText("创建模板")
          .setCta()
          .onClick(async () => {
            await this.createTemplates();
          })
      );

    // ══════════════════════════════════════════════════════
    //  AI 引擎与云端连接配置
    // ══════════════════════════════════════════════════════
    new Setting(containerEl).setName("🤖 AI 引擎与云端连接配置").setHeading();

    new Setting(containerEl)
      .setName("AI 驱动模式")
      .setDesc("推荐使用 API 直连模式（毫秒级、跨平台稳定无死锁）；或切回 CLI 本地进程模式。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("api", "🚀 HTTP API 直连（推荐，极度稳定）")
          .addOption("cli", "💻 桌面 CLI 进程调用")
          .setValue(this.plugin.settings.aiProviderMode || "api")
          .onChange(async (value: any) => {
            this.plugin.settings.aiProviderMode = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.aiProviderMode === "api" || !this.plugin.settings.aiProviderMode) {
      new Setting(containerEl)
        .setName("API Base URL")
        .setDesc("兼容 OpenAI 格式的 API 接口基地址（如 DeepSeek、硅基流动、OpenAI 等）")
        .addText((text) =>
          text
            .setPlaceholder("https://api.deepseek.com")
            .setValue(this.plugin.settings.apiBaseUrl || "https://api.deepseek.com")
            .onChange(async (value) => {
              this.plugin.settings.apiBaseUrl = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("API Key")
        .setDesc("API 授权密钥（Bearer Token），不会对外泄露")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.apiKey || "")
            .onChange(async (value) => {
              this.plugin.settings.apiKey = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("AI 模型名称")
        .setDesc("指定对话与生成的模型（如 deepseek-v4-flash, deepseek-v4-pro, gpt-4o 等）")
        .addText((text) =>
          text
            .setPlaceholder("deepseek-v4-flash")
            .setValue(this.plugin.settings.apiModel || "deepseek-v4-flash")
            .onChange(async (value) => {
              this.plugin.settings.apiModel = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("连接测试诊断")
        .setDesc("点击发送微型数据包，验证 API Key 与 Base URL 是否通信顺畅")
        .addButton((btn) =>
          btn
            .setButtonText("🔍 立即测试 API 连接")
            .setCta()
            .onClick(async () => {
              btn.setButtonText("⏳ 测试中...");
              btn.setDisabled(true);
              const res = await (this.plugin as any).getAgyEngine().testConnection();
              new Notice(res.msg);
              btn.setButtonText("🔍 立即测试 API 连接");
              btn.setDisabled(false);
            })
        );
    } else {
      new Setting(containerEl)
        .setName("agy 可执行文件路径")
        .setDesc("本地 agy CLI 的完整路径")
        .addText((text) =>
          text
            .setPlaceholder("例如: /home/user/.local/bin/agy 或留空使用 API 模式")
            .setValue(this.plugin.settings.agyCLIPath)
            .onChange(async (value) => {
              this.plugin.settings.agyCLIPath = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("AI 模型")
        .setDesc("指定 agy 使用的模型（留空则使用默认模型）")
        .addText((text) =>
          text
            .setPlaceholder("留空使用默认")
            .setValue(this.plugin.settings.agyModel)
            .onChange(async (value) => {
              this.plugin.settings.agyModel = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("超时时间（秒）")
        .setDesc("agy CLI 最长等待时间，默认 300 秒（5 分钟）")
        .addText((text) =>
          text
            .setPlaceholder("300")
            .setValue(String(this.plugin.settings.agyTimeoutSeconds))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) {
                this.plugin.settings.agyTimeoutSeconds = num;
                await this.plugin.saveSettings();
              }
            })
        );
    }

    // ══════════════════════════════════════════════════════
    //  定时任务配置
    // ══════════════════════════════════════════════════════
    new Setting(containerEl).setName("⏰ 定时任务").setHeading();

    new Setting(containerEl)
      .setName("启用每日自动生成")
      .setDesc("开启后，插件会在设定时间自动生成当日饮食计划")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoGenerate)
          .onChange(async (value) => {
            this.plugin.settings.autoGenerate = value;
            await this.plugin.saveSettings();
            new Notice(
              value
                ? "⏰ 每日自动生成已开启"
                : "⏰ 每日自动生成已关闭"
            );
          })
      );

    new Setting(containerEl)
      .setName("每日触发时间")
      .setDesc("格式 HH:MM（24 小时制），如 06:30")
      .addText((text) =>
        text
          .setPlaceholder("06:30")
          .setValue(this.plugin.settings.scheduledTime)
          .onChange(async (value) => {
            // 校验 HH:MM 格式
            if (/^\d{2}:\d{2}$/.test(value)) {
              this.plugin.settings.scheduledTime = value;
              await this.plugin.saveSettings();
            }
          })
      );

    // ── 🚫 饮食黑名单管理 ─────────────────────────
    // ── 用户自定义食材别名 ──
    new Setting(containerEl).setName("🏷️ 食材别名映射").setHeading();
    containerEl.createEl("p", {
      text: '当食谱中的食材名与内置词库不匹配时（如「三层肉」→「五花肉」），在此添加别名。每行一条，格式：别名=标准名',
      cls: "setting-item-description",
    });
    const aliasTextArea = containerEl.createEl("textarea", {
      placeholder: "三层肉=五花肉\n蕃茄=番茄\n大肉=猪肉\n去皮鸡胸=鸡胸肉",
      attr: { style: "width:100%;height:100px;font-family:monospace;font-size:12px;" },
    });
    const aliases = this.plugin.settings.foodAliases || {};
    aliasTextArea.value = Object.entries(aliases).map(([k, v]) => `${k}=${v}`).join("\n");
    aliasTextArea.addEventListener("change", async () => {
      const newAliases: Record<string, string> = {};
      for (const line of aliasTextArea.value.split("\n")) {
        const [k, ...vParts] = line.split("=");
        const key = k?.trim();
        const val = vParts.join("=").trim();
        if (key && val) newAliases[key] = val;
      }
      this.plugin.settings.foodAliases = newAliases;
      await this.plugin.saveSettings();
    });

    // ── 从网页导入食谱 ──
    new Setting(containerEl).setName("🌐 从网页导入食谱").setHeading();
    containerEl.createEl("p", {
      text: "粘贴下厨房、美食天下、AllRecipes 等食谱网页链接，自动提取菜名、食材和步骤。支持 JSON-LD 结构化数据。",
      cls: "setting-item-description",
    });
    const urlRow = containerEl.createDiv({ attr: { style: "display:flex;gap:8px;margin-bottom:8px;" } });
    const urlInput = urlRow.createEl("input", {
      type: "text",
      placeholder: "https://www.xiachufang.com/recipe/...",
      attr: { style: "flex:1;padding:8px;border:1px solid var(--nd-card-border);border-radius:6px;font-size:13px;background:var(--nd-card-bg);color:var(--nd-text);" }
    });
    const scrapeBtn = urlRow.createEl("button", {
      text: "🔍 解析食谱",
      attr: { style: "padding:8px 16px;border:1px solid var(--nd-accent);border-radius:6px;background:var(--nd-accent);color:#fff;cursor:pointer;font-weight:600;white-space:nowrap;" }
    });
    const resultDiv = containerEl.createDiv({ attr: { style: "display:none;padding:10px;border:1px solid var(--nd-card-border);border-radius:6px;margin-bottom:8px;background:var(--nd-panel-bg);" } });

    scrapeBtn.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) { new Notice("请先输入网址"); return; }
      scrapeBtn.disabled = true; scrapeBtn.setText("⏳ 获取中...");
      resultDiv.style.display = "none";
      try {
        const resp = await requestUrl({ url, method: "GET" });
        const html = resp.text;
        const scraper = (this.plugin as any).recipeScraper;

        // Tier 1: JSON-LD 快速提取
        let recipe = scraper?.scrapeFromHtml(html, url);

        // Tier 2: AI 兜底
        if (!recipe || recipe.ingredients.length === 0) {
          scrapeBtn.setText("🤖 AI 提取中...");
          const agy = (this.plugin as any).getAgyEngine?.();
          if (agy) {
            recipe = await scraper?.scrapeFromHtmlWithAI(html, agy, url);
          }
        }

        if (recipe && recipe.ingredients.length > 0) {
          resultDiv.empty();
          resultDiv.style.display = "block";
          resultDiv.createEl("strong", { text: `📋 ${recipe.name}`, attr: { style: "font-size:15px;color:var(--nd-accent);" } });
          const ingList = resultDiv.createDiv({ attr: { style: "margin:6px 0;font-size:12px;color:var(--nd-text);" } });
          ingList.createEl("strong", { text: `食材 (${recipe.ingredients.length}项):` });
          ingList.createEl("div", { text: recipe.ingredients.map((i: any) => `${i.name} ${i.grams}g`).join("、"), attr: { style: "margin-top:2px;" } });
          const stepList = resultDiv.createDiv({ attr: { style: "font-size:12px;color:var(--nd-text);max-height:120px;overflow-y:auto;" } });
          stepList.createEl("strong", { text: `步骤 (${recipe.steps.length}步):` });
          recipe.steps.slice(0, 8).forEach((s: string, i: number) => stepList.createEl("div", { text: `${i + 1}. ${s}`, attr: { style: "margin-top:2px;" } }));
          if (recipe.steps.length > 8) stepList.createEl("div", { text: `... 共${recipe.steps.length}步`, attr: { style: "color:var(--nd-text-soft);" } });
          resultDiv.createEl("div", { text: `✅ 解析成功！食材已自动匹配热量数据库。`, attr: { style: "margin-top:6px;font-size:11px;color:var(--nd-text-soft);" } });

          const saveBtnRow = resultDiv.createDiv({ attr: { style: "margin-top:8px;display:flex;justify-content:flex-end;" } });
          const saveBtn = saveBtnRow.createEl("button", {
            text: "💾 保存为食谱笔记",
            attr: { style: "padding:6px 14px;border:1px solid var(--nd-accent);border-radius:6px;background:var(--nd-accent);color:#fff;cursor:pointer;font-size:12px;font-weight:600;" }
          });
          saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true; saveBtn.setText("⏳ 保存中...");
            try {
              const folder = this.plugin.settings.mealPlanFolder || "PantryFin";
              const writer = (this.plugin as any).mealPlanWriter;
              if (writer && typeof writer.ensureFolder === "function") {
                await writer.ensureFolder(folder);
              } else {
                const parts = folder.split("/");
                let curr = "";
                for (const p of parts) {
                  curr = curr ? `${curr}/${p}` : p;
                  if (!this.plugin.app.vault.getAbstractFileByPath(curr)) {
                    await this.plugin.app.vault.createFolder(curr).catch(() => {});
                  }
                }
              }
              let totalCals = 0;
              const ingTableRows = recipe.ingredients.map((i: any) => {
                const match = getFoodDatabase().lookupChinese(i.name);
                const cals = match?.nutrients?.calories ?? 0;
                const cal = cals ? Math.round((i.grams / 100) * cals) : 0;
                totalCals += cal;
                return `| **${i.name}** | ${i.grams}g | ${cal > 0 ? cal + " kcal" : "-"} | ${i.note || "-"} |`;
              }).join("\n");

              const cleanName = recipe.name.replace(/[\\/:*?"<>|]/g, "_");
              // 同名菜谱自动加来源后缀，支持多种做法共存
              let filePath = `${folder}/食谱-${cleanName}.md`;
              if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
                const domain = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; } })();
                const suffix = domain ? ` (${domain.split(".")[0]})` : " (另一做法)";
                filePath = `${folder}/食谱-${cleanName}${suffix}.md`;
                let counter = 2;
                while (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
                  filePath = `${folder}/食谱-${cleanName}${suffix}${counter}.md`;
                  counter++;
                }
              }
              let archiveBlock = "";
              if (html && (this.plugin as any).htmlArchiver) {
                const archivePath = await (this.plugin as any).htmlArchiver.archive(html, url.trim(), recipe.name);
                if (archivePath) {
                  const basePath = (this.plugin.app.vault.adapter as any).getBasePath ? (this.plugin.app.vault.adapter as any).getBasePath() : "";
                  const browserUrl = basePath ? `file://${basePath}/${archivePath}`.replace(/ /g, "%20") : archivePath;
                  const resourceUrl = this.plugin.app.vault.adapter.getResourcePath(archivePath);
                  archiveBlock = `\n\n---\n\n## 🌐 完整网页版\n\n- [🚀 在系统浏览器中打开原网页 (100%排版保真)](${browserUrl})\n- [📄 查看本地源码附件](${archivePath})\n\n<details>\n  <summary>💻 笔记内实时预览网页 (点击展开)</summary>\n  <iframe src="${resourceUrl}" width="100%" height="650px" style="border:1px solid #e0e0e0; border-radius:8px; margin-top:10px;"></iframe>\n</details>\n`;
                }
              }

              const content = `---
tags: [食谱, PantryFin]
source: "${url}"
calories_total: ${totalCals}
---

# ${recipe.name}

> 🌐 **来源网页**: [原网页链接](${url})  
> 🔥 **估算总热量**: ~${totalCals} kcal

## 🥩 食材清单

| 食材名称 | 标准克重 | 预估热量 | 烹饪备注 |
|---|---|---|---|
${ingTableRows}

## 🍳 烹饪步骤

${recipe.steps.map((s: string, idx: number) => `${idx + 1}. ${s}`).join("\n\n")}
` + archiveBlock;
              await this.plugin.app.vault.create(filePath, content);
              new Notice(`✅ 食谱笔记已创建: ${filePath}`);
              saveBtn.setText("✅ 已保存至笔记库");
            } catch (err) {
              new Notice(`❌ 保存失败: ${(err as Error).message}`);
              saveBtn.disabled = false; saveBtn.setText("💾 保存为食谱笔记");
            }
          });
        } else {
          new Notice("⚠️ 未找到食谱数据，该网页可能不支持结构化食谱格式");
        }
      } catch (e) {
        new Notice(`❌ 获取失败: ${(e as Error).message || "网络错误"}`);
      }
      scrapeBtn.disabled = false; scrapeBtn.setText("🔍 解析食谱");
    });

    // ── 自动化预处理规则 ──
    new Setting(containerEl).setName("⚙️ 自动化预处理规则").setHeading();
    containerEl.createEl("p", {
      text: "在食材解析前自动替换文本。每行一条：匹配文本=替换文本。例如「去皮鸡胸肉=鸡胸肉」",
      cls: "setting-item-description",
    });
    const autoTextArea = containerEl.createEl("textarea", {
      placeholder: "去皮鸡胸肉=鸡胸肉\ncups=ml\n冰鲜=新鲜",
      attr: { style: "width:100%;height:60px;font-family:monospace;font-size:12px;" },
    });
    const rules = this.plugin.settings.automationRules || [];
    autoTextArea.value = rules.map(r => `${r.pattern}=${r.replacement}`).join("\n");
    autoTextArea.addEventListener("change", async () => {
      const newRules: AutomationRule[] = [];
      for (const line of autoTextArea.value.split("\n")) {
        const [p, ...rParts] = line.split("=");
        const pattern = p?.trim();
        const replacement = rParts.join("=").trim();
        if (pattern && replacement) {
          newRules.push({ type: "food_replace", pattern, replacement, enabled: true });
        }
      }
      this.plugin.settings.automationRules = newRules;
      await this.plugin.saveSettings();
    });

    // AI 食材校验按钮
    const aiCheckRow = containerEl.createDiv({ attr: { style: "margin-bottom:16px;" } });
    const aiInput = aiCheckRow.createEl("input", {
      type: "text",
      placeholder: "输入食材名进行 AI 校验，如「三层肉」",
      attr: { style: "padding:6px 10px;border:1px solid var(--nd-card-border);border-radius:6px;font-size:12px;width:200px;background:var(--nd-card-bg);color:var(--nd-text);margin-right:8px;" }
    });
    const aiBtn = aiCheckRow.createEl("button", {
      text: "🤖 AI 校验",
      attr: { style: "padding:6px 14px;border:1px solid var(--nd-accent);border-radius:6px;background:var(--nd-card-bg);color:var(--nd-accent);cursor:pointer;font-weight:600;font-size:12px;" }
    });
    const aiResult = aiCheckRow.createEl("span", { attr: { style: "font-size:12px;color:var(--nd-text-soft);margin-left:8px;" } });
    aiBtn.addEventListener("click", async () => {
      const name = aiInput.value.trim();
      if (!name) { new Notice("请先输入食材名"); return; }
      aiBtn.disabled = true; aiBtn.setText("⏳ 校验中..."); aiResult.setText("");
      try {
        const validator = (this.plugin as any).ingredientValidator;
        const result = await validator?.validate(name);
        if (result?.variations?.length > 0) {
          aiResult.setText(`💡 建议: ${result.variations.join(" / ")}`);
        } else if (result?.isValid) {
          aiResult.setText("✅ 该食材名已为标准名");
        } else {
          aiResult.setText("⚠️ 未找到建议，请手动确认");
        }
      } catch (e) { aiResult.setText("❌ 校验失败，请检查 API 连接"); }
      aiBtn.disabled = false; aiBtn.setText("🤖 AI 校验");
    });

    // ── 数据导入导出 ──
    new Setting(containerEl).setName("💾 数据备份与迁移").setHeading();
    containerEl.createEl("p", {
      text: "导出全部设置、食谱替换记录、食材别名和打卡历史。在新设备上导入即可无缝迁移。",
      cls: "setting-item-description",
    });
    const ioRow = containerEl.createDiv({ attr: { style: "display:flex;gap:8px;margin-bottom:16px;" } });
    const exportBtn = ioRow.createEl("button", {
      text: "📤 导出全部数据",
      attr: { style: "padding:8px 16px;border:1px solid var(--nd-accent);border-radius:6px;background:var(--nd-accent);color:#fff;cursor:pointer;font-weight:600;" }
    });
    exportBtn.addEventListener("click", () => {
      try {
        const bm = (this.plugin as any).backupManager;
        const json = bm?.exportAll();
        if (json) {
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = `pantryfin-backup-${new Date().toISOString().split("T")[0]}.json`;
          a.click(); URL.revokeObjectURL(url);
          new Notice("✅ 数据已导出");
        }
      } catch (e) { new Notice(`❌ 导出失败: ${e}`); }
    });

    const importInput = document.createElement("input");
    importInput.type = "file"; importInput.accept = ".json";
    importInput.style.cssText = "display:none;";
    ioRow.appendChild(importInput);
    const importBtn = ioRow.createEl("button", {
      text: "📥 导入备份",
      attr: { style: "padding:8px 16px;border:1px solid var(--nd-card-border);border-radius:6px;background:var(--nd-card-bg);color:var(--nd-text);cursor:pointer;font-weight:600;" }
    });
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const bm = (this.plugin as any).backupManager;
        const result = bm?.importAll(text);
        if (result?.success) {
          new Notice(`✅ ${result.message}`);
          this.display(); // 刷新面板显示恢复的数据
        } else {
          new Notice(`❌ ${result?.message || "导入失败"}`);
        }
      } catch (e) { new Notice(`❌ 文件读取失败: ${e}`); }
    });

    new Setting(containerEl).setName("🚫 饮食屏蔽小黑屋").setHeading();
    containerEl.createEl("p", { text: "管理标记为吃腻了的食材，屏蔽期内 AI 不会推荐。", cls: "setting-item-description" });
    const blContainer = containerEl.createDiv();
    blContainer.createEl("p", { text: "⏳ 加载中...", attr: { style: "color:var(--text-faint);" } });
    (async () => {
      try {
        const rules = await (this.plugin as any).ruleManager?.getActiveFatigueRules?.() || [];
        blContainer.empty();
        if (rules.length === 0) { blContainer.createEl("p", { text: "✨ 没有被屏蔽的食材", attr: { style: "color:var(--text-muted);" } }); return; }
        for (const item of rules) {
          new Setting(blContainer).setName(`🚫 ${item.ingredient}`).setDesc(`屏蔽至：${item.expireDate}`).addButton(btn => btn.setButtonText("🗑️ 解除").onClick(async () => {
            btn.setDisabled(true); btn.setButtonText("...");
            await (this.plugin as any).ruleManager?.removeRuleLine?.(item.rawLine);
            new Notice(`✅ 已解除`); this.display();
          }));
        }
      } catch { blContainer.empty(); blContainer.createEl("p", { text: "❌ 加载失败" }); }
    })();
  }

  // ── 模板创建逻辑 ───────────────────────────────────────
  private async createTemplates(): Promise<void> {
    const vault = this.app.vault;
    let created = 0;

    // Profile.md 模板
    const profilePath = this.plugin.settings.profilePath;
    if (!vault.getAbstractFileByPath(profilePath)) {
      const profileContent = `---
height_cm: 175
weight_kg: 70
age: 25
gender: male
activity_level: moderate
goal_type: fat_loss
target_weight_kg: 65
weekly_rate_kg: -0.5
allergies: []
dislikes: []
dietary_style: balanced
---
# 个人膳食设计档案

> 修改上方数字即可，AI 会自动识别。\n> gender: male 或 female\n> activity_level: sedentary / light / moderate / active / very_active\n> goal_type: fat_loss / muscle_gain / maintenance\n> dietary_style: balanced / low_carb / keto / mediterranean / high_protein
`;
      // 确保目录存在
      const dir = profilePath.substring(0, profilePath.lastIndexOf("/"));
      if (dir && !vault.getAbstractFileByPath(dir)) {
        await vault.createFolder(dir);
      }
      await vault.create(profilePath, profileContent);
      created++;
    }

    // Pantry.md 模板
    const pantryPath = this.plugin.settings.pantryPath;
    if (!vault.getAbstractFileByPath(pantryPath)) {
      const pantryContent = `# 🥬 食材库存清单

> PantryFin 会自动读取下表，并在生成菜单后建议扣减。
> 数量列为纯数字(base值)，单位列记录基准单位(g/ml/枚)。

| 食材类别 | 食材名称 | 数量 | 单位 | 采购日期 |
| :--- | :--- | :--- | :--- | :--- |
| 蛋白质 | 鸡胸肉 | 500 | g | ${new Date().toISOString().split("T")[0]} |
| 蛋白质 | 鸡蛋 | 10 | 枚 | ${new Date().toISOString().split("T")[0]} |
`;
      const dir = pantryPath.substring(0, pantryPath.lastIndexOf("/"));
      if (dir && !vault.getAbstractFileByPath(dir)) {
        await vault.createFolder(dir);
      }
      await vault.create(pantryPath, pantryContent);
      created++;
    }

    if (created > 0) {
      new Notice(`✅ 已创建 ${created} 个模板文件`);
    } else {
      new Notice("ℹ️ 模板文件已存在，未覆盖");
    }
  }
}
