// src/views/RecipePickerModal.ts
//
// 放纵日自选餐 Modal v2.0：分类侧栏 + 菜谱网格 + 餐次直接替换 + 日期预定。
// 选择餐次后立即替换当天（或指定日期）该餐的食谱并关闭。

import { App, Modal, Notice, TFile, requestUrl, Platform } from "obsidian";
import type NutriAgentPlugin from "../main";
import type { ParsedRecipe, MealSlot } from "../models/types";
import { MEAL_SLOTS } from "../models/types";
import { getFoodDatabase } from "../nutrition/FoodDatabase";
import { RichRecipeScraper } from "../services/RichRecipeScraper";

export class RecipePickerModal extends Modal {
  private selectedCategory = "all";
  private activeTab: "builtin" | "user" | "import" = "builtin";
  private deleteMode = false;
  private searchQuery = "";
  private plugin: NutriAgentPlugin;
  private date: string;

  constructor(app: App, plugin: NutriAgentPlugin, date: string) {
    super(app);
    this.plugin = plugin;
    this.date = date;
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    contentEl.addClass("recipe-picker-root");
    // 全屏模式
    modalEl.setCssStyles({ width: "100vw", maxWidth: "100vw", height: "100vh", maxHeight: "100vh", margin: "0", borderRadius: "0" });
    modalEl.addClass("recipe-picker-fullscreen");

    // P0 移动端: 遮罩层拦截 touchmove 防止滚动穿透到背景
    if (Platform.isMobile) {
      modalEl.addEventListener("touchmove", (e: TouchEvent) => {
        e.preventDefault();
      }, { passive: false });
    }

    this.render();
  }

  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    // ── Header ──
    const header = contentEl.createDiv({ attr: { style: "padding:16px 20px;border-bottom:1px solid var(--nd-card-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;" } });
    header.createEl("h2", { text: "🐟 PantryFin 食谱中枢", attr: { style: "margin:0;font-size:20px;" } });

    const fmtLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const now = new Date();
    const todayStr = fmtLocal(now);

    const ctrlRow = header.createDiv({ attr: { style: "display:flex;gap:8px;align-items:center;" } });
    const dateSelect = ctrlRow.createEl("select", {
      attr: { style: "padding:6px 10px;border:1px solid var(--nd-card-border);border-radius:6px;font-size:13px;background:var(--nd-card-bg);color:var(--nd-text);" }
    });
    [
      { label: `📅 今天 (${todayStr})`, value: todayStr },
      { label: `📅 明天 (${fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate()+1))})`, value: fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate()+1)) },
      { label: `📅 后天 (${fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate()+2))})`, value: fmtLocal(new Date(now.getFullYear(), now.getMonth(), now.getDate()+2)) },
    ].forEach(opt => {
      const o = dateSelect.createEl("option", { text: opt.label });
      o.value = opt.value;
      if (this.date === opt.value) o.selected = true;
    });
    dateSelect.addEventListener("change", () => { this.date = dateSelect.value; this.rerenderGrid(); this.refreshFooter(); });

    const searchInput = ctrlRow.createEl("input", {
      type: "text", placeholder: "搜索菜名或食材...",
      attr: { style: "padding:6px 10px;border:1px solid var(--nd-card-border);border-radius:6px;font-size:13px;width:160px;background:var(--nd-card-bg);color:var(--nd-text);" }
    });
    searchInput.addEventListener("input", () => { this.searchQuery = searchInput.value.trim(); this.rerenderGrid(); });

    // ── Tab 栏 ──
    const tabBar = contentEl.createDiv({ attr: { style: "display:flex;border-bottom:1px solid var(--nd-card-border);padding:0 20px;gap:0;" } });
    const tabs: { id: string; label: string }[] = [
      { id: "builtin", label: "🥘 内置菜谱" },
      { id: "user", label: "📂 我的食谱" },
      { id: "import", label: "🌐 网页导入" },
    ];
    for (const tab of tabs) {
      const btn = tabBar.createEl("button", {
        text: tab.label,
        attr: { style: `padding:10px 18px;border:none;border-bottom:2px solid ${this.activeTab === tab.id ? "var(--nd-accent)" : "transparent"};background:none;color:${this.activeTab === tab.id ? "var(--nd-accent)" : "var(--nd-text-soft)"};font-size:14px;font-weight:${this.activeTab === tab.id ? "700" : "400"};cursor:pointer;transition:all 0.15s;` }
      });
      btn.addEventListener("click", () => { this.activeTab = tab.id as typeof this.activeTab; this.render(); });
    }

    // 我的食谱 Tab：右下角浮动删除按钮
    if (this.activeTab === "user") {
      this._renderDeleteModeButton(contentEl);
    }

    // ── Body ──
    if (this.activeTab === "import") {
      this.renderImportTab(contentEl);
    } else {
      const body = contentEl.createDiv({ cls: "recipe-picker-body", attr: { style: "flex:1;display:flex;overflow:hidden;" } });
      if (this.activeTab === "builtin") {
        const sidebar = body.createDiv({ cls: "recipe-picker-sidebar" });
        this.renderSidebar(sidebar);
      }
      const gridWrap = body.createDiv({ attr: { style: "flex:1;overflow-y:auto;padding:12px;" } });
      const grid = gridWrap.createDiv({ cls: "recipe-picker-grid" });
      this.renderRecipeGrid(grid);
    }

    // ── Footer ──
    const footer = contentEl.createDiv({ cls: "recipe-picker-footer", attr: { style: "padding:10px 20px;border-top:1px solid var(--nd-card-border);" } });
    this.renderFooter(footer);
  }

  /** 网页导入 Tab：URL 输入 + 解析 + 预览 + 保存 */
  private renderImportTab(container: HTMLElement): void {
    const wrap = container.createDiv({ attr: { style: "flex:1;padding:24px 20px;overflow-y:auto;display:flex;flex-direction:column;align-items:center;" } });
    wrap.createEl("h3", { text: "🌐 从食谱网页导入", attr: { style: "margin-bottom:8px;" } });
    wrap.createEl("p", { text: "粘贴下厨房、美食天下、AllRecipes、BBC Good Food 等食谱网页链接", attr: { style: "color:var(--nd-text-soft);font-size:13px;margin-bottom:16px;" } });

    const inputRow = wrap.createDiv({ attr: { style: "display:flex;gap:8px;width:100%;max-width:600px;" } });
    const urlInput = inputRow.createEl("input", {
      type: "text", placeholder: "https://www.xiachufang.com/recipe/...",
      attr: { style: "flex:1;padding:10px;border:1px solid var(--nd-card-border);border-radius:8px;font-size:14px;background:var(--nd-card-bg);color:var(--nd-text);" }
    });
    const scrapeBtn = inputRow.createEl("button", {
      text: "🔍 解析", attr: { style: "padding:10px 20px;border:none;border-radius:8px;background:var(--nd-accent);color:#fff;cursor:pointer;font-weight:600;font-size:14px;white-space:nowrap;" }
    });

    const resultDiv = wrap.createDiv({ attr: { style: "display:none;margin-top:16px;width:100%;max-width:600px;padding:16px;border:1px solid var(--nd-card-border);border-radius:8px;background:var(--nd-panel-bg);" } });

    scrapeBtn.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) { new Notice("请先输入网址"); return; }
      scrapeBtn.disabled = true; scrapeBtn.setText("⏳ ...");
      resultDiv.setCssStyles({ display: "none" });
      try {
        const resp = await requestUrl({ url, method: "GET" });
        const scraper = (this.plugin as any).recipeScraper;
        let recipe = scraper?.scrapeFromHtml(resp.text, url);
        if (!recipe || recipe.ingredients.length === 0) {
          scrapeBtn.setText("🤖 AI...");
          const agy = (this.plugin as any).getAgyEngine?.();
          if (agy) recipe = await scraper?.scrapeFromHtmlWithAI(resp.text, agy, url);
        }
        if (recipe && recipe.ingredients.length > 0) {
          resultDiv.empty(); resultDiv.setCssStyles({ display: "block" });
          resultDiv.createEl("strong", { text: `📋 ${recipe.name}`, attr: { style: "font-size:16px;color:var(--nd-accent);" } });
          if (recipe.imageUrl) {
            resultDiv.createEl("img", { attr: { src: recipe.imageUrl, loading: "lazy", style: "max-width:100%;max-height:200px;border-radius:8px;margin-top:8px;" } });
          }
          resultDiv.createDiv({ text: `食材: ${recipe.ingredients.map((i: any) => `${i.name} ${i.grams}g`).join("、")}`, attr: { style: "margin-top:6px;font-size:13px;" } });
          const saveBtn = resultDiv.createEl("button", {
            text: "💾 保存到我的食谱", attr: { style: "margin-top:10px;padding:8px 16px;border:none;border-radius:6px;background:var(--nd-accent);color:#fff;cursor:pointer;font-weight:600;" }
          });
          saveBtn.addEventListener("click", async () => {
            saveBtn.disabled = true; saveBtn.setText("⏳ ...");
            await this._saveImportedRecipe(recipe!, url, resp.text);
            saveBtn.setText("✅ 已保存"); new Notice("✅ 食谱已保存，切换到「我的食谱」查看");
          });
        } else { new Notice("⚠️ 未能解析"); }
      } catch (e) { new Notice(`❌ ${(e as Error).message}`); }
      scrapeBtn.disabled = false; scrapeBtn.setText("🔍 解析");
    });
  }

  /** 保存导入的食谱为 Markdown 笔记 */
  private async _saveImportedRecipe(recipe: any, url: string, rawHtml?: string): Promise<void> {
    const folder = this.plugin.settings.mealPlanFolder || "PantryFin";
    const parts = folder.split("/"); let curr = "";
    for (const p of parts) { curr = curr ? `${curr}/${p}` : p; if (!this.app.vault.getAbstractFileByPath(curr)) await this.app.vault.createFolder(curr).catch(() => {}); }
    const cleanName = recipe.name.replace(/[\\/:*?"<>|]/g, "_");
    let filePath = `${folder}/食谱-${cleanName}.md`;
    if (this.app.vault.getAbstractFileByPath(filePath)) {
      const domain = (() => { try { return new URL(url).hostname.replace("www.",""); } catch { return ""; } })();
      const suffix = domain ? ` (${domain.split(".")[0]})` : " (另一做法)";
      filePath = `${folder}/食谱-${cleanName}${suffix}.md`; let c = 2;
      while (this.app.vault.getAbstractFileByPath(filePath)) { filePath = `${folder}/食谱-${cleanName}${suffix}${c}.md`; c++; }
    }
    let totalCals = 0; const db = getFoodDatabase();
    for (const ing of recipe.ingredients) {
      const m = db.lookupChinese(ing.name); totalCals += m?.nutrients?.Energy ? Math.round((ing.grams/100)*m.nutrients.Energy) : 0;
    }

    let archiveBlock = "";
    if (rawHtml && (this.plugin as any).htmlArchiver) {
      const archivePath = await (this.plugin as any).htmlArchiver.archive(rawHtml, url.trim(), recipe.name);
      if (archivePath) {
        const basePath = (this.app.vault.adapter as any).getBasePath ? (this.app.vault.adapter as any).getBasePath() : "";
        const browserUrl = basePath ? `file://${basePath}/${archivePath}`.replace(/ /g, "%20") : archivePath;
        const resourceUrl = this.app.vault.adapter.getResourcePath(archivePath);
        archiveBlock = `\n\n---\n\n## 🌐 完整网页版\n\n- [🚀 在系统浏览器中打开原网页 (100%排版保真)](${browserUrl})\n- [📄 查看本地源码附件](${archivePath})\n\n<details>\n  <summary>💻 笔记内实时预览网页 (点击展开)</summary>\n  <iframe src="${resourceUrl}" width="100%" height="650px" style="border:1px solid #e0e0e0; border-radius:8px; margin-top:10px;"></iframe>\n</details>\n`;
      }
    }

    // v4.3: RichRecipe 使用 toMarkdown，旧格式保留兼容
    const isRich = recipe.allImages !== undefined;
    if (isRich) {
      const md = RichRecipeScraper.toMarkdown(recipe, totalCals) + archiveBlock;
      await this.app.vault.create(filePath, md);
      return;
    }
    // 旧格式回退 (ScrapedRecipe 兼容)
    const rows = recipe.ingredients.map((i: any) => {
      const m = db.lookupChinese(i.name); const cal = m?.nutrients?.Energy ? Math.round((i.grams/100)*m.nutrients.Energy) : 0;
      return `| **${i.name}** | ${i.grams}g | ${cal > 0 ? cal+" kcal" : "-"} | ${i.note||"-"} |`;
    }).join("\n");
    const imgBlock = recipe.imageUrl ? `\n![${recipe.name}](${recipe.imageUrl})\n` : "";
    const stepsText = Array.isArray(recipe.steps)
      ? (typeof recipe.steps[0] === "string"
          ? recipe.steps.map((s: string, i: number) => `${i+1}. ${s}`).join("\n\n")
          : recipe.steps.map((s: any) => `### ${s.number}. \n${s.images?.map((u: string) => `![步骤${s.number}](${u})`).join("\n") || ""}\n${s.text}`).join("\n\n"))
      : "";
    const md = [
      "---",
      `tags: [食谱, PantryFin]`,
      `source: "${url}"`,
      `image: "${recipe.imageUrl || ""}"`,
      `description: "${(recipe.description || "").replace(/"/g, '\\"')}"`,
      `calories_total: ${totalCals}`,
      "---",
      "",
      `# ${recipe.name}`,
      imgBlock,
      `> 🌐 [原网页](${url})  |  🔥 ~${totalCals} kcal`,
      "",
      "## 🥩 食材清单",
      "",
      "| 食材名称 | 标准克重 | 预估热量 | 烹饪备注 |",
      "|---|---|---|---|",
      rows,
      "",
      "## 👨‍🍳 烹饪步骤",
      "",
      stepsText,
    ].join("\n") + archiveBlock;
    await this.app.vault.create(filePath, md);
  }

  private userRecipes: ParsedRecipe[] = [];

  private async renderSidebar(container: HTMLElement): Promise<void> {
    container.empty();
    const cats = this.plugin.recipeLibrary?.getCategories() || [];

    const allBtn = container.createEl("button", {
      text: `📋 全部 (${this.plugin.recipeLibrary?.getTotalCount() || 0})`,
      cls: `recipe-picker-cat-btn ${this.selectedCategory === "all" ? "is-active" : ""}`,
    });
    allBtn.addEventListener("click", () => { this.selectedCategory = "all"; this.rerenderGrid(); this.renderSidebar(container); });

    for (const cat of cats) {
      if (cat.count === 0) continue;
      const btn = container.createEl("button", {
        text: `${this.catEmoji(cat.id)} ${cat.label} (${cat.count})`,
        cls: `recipe-picker-cat-btn ${this.selectedCategory === cat.id ? "is-active" : ""}`,
      });
      btn.addEventListener("click", () => { this.selectedCategory = cat.id; this.rerenderGrid(); this.renderSidebar(container); });
    }
  }

  /** 扫描 mealPlanFolder 中导入的食谱笔记，解析为完整 ParsedRecipe */
  private async _scanUserRecipes(): Promise<void> {
    this.userRecipes = [];
    const folder = this.plugin.settings.mealPlanFolder || "PantryFin";
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder) && f.path.includes("食谱-"));
    for (const file of files) {
      try {
        const content = await this.app.vault.read(file);
        const name = file.basename.replace(/^食谱-/, "").replace(/\.md$/, "");
        const sourceMatch = name.match(/^(.+?)\s*\(([^)]+)\)$/);
        const displayName = sourceMatch ? sourceMatch[1]! : name;

        // 解析 frontmatter 热量
        let calTotal = 0;
        const calMatch = content.match(/calories_total:\s*(\d+)/);
        if (calMatch) calTotal = parseInt(calMatch[1]!, 10);

        // 解析食材表格: | **食材名** | 克重g | 热量 | 备注 |
        const ingredients: ParsedRecipe["ingredients"] = [];
        const tableSection = content.match(/##\s*🥩\s*食材清单[\s\S]*?(?=\n##\s|$)/);
        if (tableSection) {
          const rows = tableSection[0].split("\n").filter(l => l.includes("|") && l.includes("**"));
          for (const row of rows) {
            const cells = row.split("|").map(c => c.trim()).filter(Boolean);
            if (cells.length >= 2) {
              const ingName = cells[0]!.replace(/\*\*/g, "");
              const gramMatch = cells[1]!.match(/(\d+)\s*g/);
              const grams = gramMatch ? parseInt(gramMatch[1]!, 10) : 0;
              const note = cells.length >= 4 && cells[3] !== "-" ? cells[3] : undefined;
              if (ingName && grams > 0) {
                ingredients.push({ name: ingName, amountGrams: grams, isCore: grams >= 20 });
                if (note) (ingredients[ingredients.length - 1]! as any).note = note;
              }
            }
          }
        }

        // 如果 frontmatter 热量为 0，用 FoodDatabase 实时计算兜底
        if (calTotal === 0 && ingredients.length > 0) {
          const db = getFoodDatabase();
          for (const ing of ingredients) {
            const match = db.lookupChinese(ing.name);
            if (match?.nutrients?.Energy) calTotal += Math.round((ing.amountGrams / 100) * match.nutrients.Energy);
          }
        }

        // 解析步骤
        const stepsSection = content.match(/##\s*🍳\s*烹饪步骤[\s\S]*?(?=\n##\s|$)/);
        const stepsPreview = stepsSection
          ? stepsSection[0].split("\n").filter(l => /^\d+\./.test(l.trim())).slice(0, 3).join(" ").substring(0, 100)
          : "";

        this.userRecipes.push({
          id: `user:${file.path}`,
          name: displayName,
          category: "user",
          categoryLabel: "我的食谱",
          difficulty: 1,
          caloriesPerServe: calTotal,
          ingredients,
          stepsPreview,
        });
      } catch { /* skip unreadable files */ }
    }
  }

  private rerenderGrid(): void {
    const grid = this.contentEl.querySelector(".recipe-picker-grid") as HTMLElement;
    if (grid) { grid.empty(); this.renderRecipeGrid(grid); }
  }

  private refreshFooter(): void {
    const footer = this.contentEl.querySelector(".recipe-picker-footer") as HTMLElement;
    if (footer) { footer.empty(); this.renderFooter(footer); }
  }

  private async renderRecipeGrid(container: HTMLElement): Promise<void> {
    let recipes: ParsedRecipe[];
    if (this.activeTab === "user") {
      await this._scanUserRecipes();
      recipes = this.searchQuery
        ? this.userRecipes.filter(r => r.name.includes(this.searchQuery))
        : this.userRecipes;
    } else if (this.searchQuery) {
      recipes = this.plugin.recipeLibrary?.searchRecipes(this.searchQuery) || [];
    } else {
      recipes = this.plugin.recipeLibrary?.getRecipesByCategory(this.selectedCategory) || [];
    }
    if (recipes.length === 0) {
      container.createEl("p", { text: "😕 没有找到匹配的菜谱", attr: { style: "padding:24px;color:var(--nd-text-soft);text-align:center;" } });
      return;
    }
    for (const recipe of recipes) {
      this.renderRecipeCard(container, recipe);
    }
  }

  private renderRecipeCard(container: HTMLElement, recipe: ParsedRecipe): void {
    const card = container.createDiv({ cls: "recipe-picker-card", attr: { style: "position:relative;" } });

    // 标题
    card.createDiv({ cls: "recipe-picker-card-name", text: recipe.name });

    // 元数据
    const meta = card.createDiv({ cls: "recipe-picker-card-meta" });
    meta.createSpan({ cls: "recipe-picker-cat-badge", text: this.catEmoji(recipe.category) + " " + recipe.categoryLabel });
    if (recipe.category !== "user") {
      meta.createSpan({ cls: "recipe-picker-diff", text: "★".repeat(recipe.difficulty) + "☆".repeat(5 - recipe.difficulty) });
    }
    const calColor = recipe.caloriesPerServe > 800 ? "#dc2626" : recipe.caloriesPerServe > 500 ? "#f59e0b" : "#16a34a";
    meta.createSpan({
      cls: "recipe-picker-cal-badge",
      text: `🔥 ${recipe.caloriesPerServe || "?"} kcal`,
      attr: { style: `background:${calColor}15;color:${calColor};padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600;` }
    });

    // 食材预览
    if (recipe.ingredients.length > 0) {
      const coreIng = recipe.ingredients.filter(i => i.isCore).slice(0, 4);
      card.createDiv({ text: `📋 ${coreIng.map(i => i.name).join("、")}${recipe.ingredients.filter(i => i.isCore).length > 4 ? "…" : ""}`, attr: { style: "font-size:11px;color:var(--nd-text-soft);margin-top:4px;" } });
    }

    // 展开详情
    const detail = card.createDiv({ cls: "recipe-picker-detail", attr: { style: "display:none;margin-top:8px;padding-top:8px;border-top:1px solid var(--nd-card-border);" } });
    if (recipe.ingredients.length > 0) {
      const ingList = detail.createDiv({ attr: { style: "margin-bottom:6px;" } });
      ingList.createEl("strong", { text: "📋 完整用料", attr: { style: "font-size:12px;color:var(--nd-accent);" } });
      const allIng = recipe.ingredients.map(i => {
        const g = Math.round(i.amountGrams);
        const unit = i.amountGrams >= 1000 ? `${(i.amountGrams/1000).toFixed(1)}kg` : `${g}g`;
        return `${i.name} ${unit}`;
      }).join("、");
      ingList.createEl("div", { text: allIng, attr: { style: "font-size:11px;color:var(--nd-text);line-height:1.5;margin-top:2px;" } });
    }
    if (recipe.stepsPreview) {
      const sd = detail.createDiv();
      sd.createEl("strong", { text: "👨‍🍳 制作方式", attr: { style: "font-size:12px;color:var(--nd-accent);" } });
      sd.createEl("div", { text: recipe.stepsPreview, attr: { style: "font-size:11px;color:var(--nd-text);line-height:1.5;margin-top:2px;" } });
    }

    let expanded = false;
    card.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".recipe-picker-slot-btn")) return;
      expanded = !expanded;
      detail.setCssStyles({ display: expanded ? "block" : "none" });
    });
    // 删除模式：用户食谱卡片可点击删除
    if (this.deleteMode && recipe.id.startsWith("user:")) {
      card.setCssStyles({ border: "2px solid #e74c3c", cursor: "pointer" });
      card.addEventListener("click", async () => {
        const filePath = recipe.id.replace("user:", "");
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          await this.app.fileManager.trashFile(file);
          new Notice(`🗑️ 已删除: ${recipe.name}`);
          this.rerenderGrid();
        }
      });
      return; // 删除模式下不渲染餐次按钮
    }

    card.setCssStyles({ cursor: "pointer" });

    // ── 餐次按钮行：直接替换 ──
    const btnRow = card.createDiv({ attr: { style: "display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;" } });
    const curReplacements = this.plugin.settings.mealReplacements?.[this.date] || {};

    for (const slot of MEAL_SLOTS) {
      const existing = curReplacements[slot];
      const isThis = existing?.recipeId === recipe.id;
      const slotBtn = btnRow.createEl("button", {
        text: `${this.slotEmoji(slot)} ${slot}`,
        cls: `recipe-picker-slot-btn`,
        attr: { style: `flex:1;min-width:50px;padding:4px 6px;border:1px solid ${isThis ? "var(--nd-accent)" : "var(--nd-card-border)"};border-radius:6px;background:${isThis ? "var(--nd-accent)" : "var(--nd-card-bg)"};color:${isThis ? "#fff" : "var(--nd-text-soft)"};font-size:10px;cursor:pointer;font-weight:600;transition:all 0.15s;` }
      });
      slotBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (isThis) {
          // 取消替换
          await this.plugin.cheatDayManager?.removeReplacement(this.date, slot);
        } else {
          await this.plugin.cheatDayManager?.setReplacement(this.date, slot, recipe.id, recipe.name, recipe.caloriesPerServe);
        }
        new Notice(isThis ? `已取消 ${slot} 替换` : `✅ ${recipe.name} → ${this.date} ${slot}`);
        this.rerenderGrid();
        this.refreshFooter();
        // 刷新仪表盘
        try { (this.plugin as any).api?.hooks?.trigger("planGenerated", { date: this.date }); } catch {}
        this.close();
      });
    }
  }

  private renderFooter(container: HTMLElement): void {
    const cur = this.plugin.settings.mealReplacements?.[this.date] || {};
    const hasAny = Object.keys(cur).length > 0;
    const now = new Date();
    const isToday = this.date === `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

    container.createEl("span", {
      text: isToday ? "📅 今天" : `📅 ${this.date}`,
      attr: { style: "font-size:12px;font-weight:600;color:var(--nd-text);" }
    });

    for (const slot of MEAL_SLOTS) {
      const repl = cur[slot];
      const recipe = repl ? this.plugin.recipeLibrary?.getRecipe(repl.recipeId) : null;
      container.createEl("span", {
        text: `${this.slotEmoji(slot)} ${slot}: ${recipe ? recipe.name : "—"}`,
        attr: { style: `font-size:11px;padding:3px 8px;border-radius:12px;border:1px solid ${recipe ? "var(--nd-accent)" : "var(--nd-card-border)"};background:${recipe ? "var(--nd-accent-soft)" : "transparent"};color:${recipe ? "var(--nd-accent)" : "var(--nd-text-soft)"};font-weight:${recipe ? "600" : "400"};` }
      });
    }

    // 取消全部预定按钮
    if (hasAny) {
      const cancelAllBtn = container.createEl("button", {
        text: "🗑️ 取消全部预定",
        attr: { style: "padding:4px 12px;border:1px solid #e74c3c;border-radius:6px;background:transparent;color:#e74c3c;font-size:11px;cursor:pointer;font-weight:600;margin-left:8px;" }
      });
      cancelAllBtn.addEventListener("click", async () => {
        for (const slot of MEAL_SLOTS) {
          if (cur[slot]) await this.plugin.cheatDayManager?.removeReplacement(this.date, slot);
        }
        new Notice(`✅ 已取消 ${this.date} 全部预定`);
        this.rerenderGrid();
        this.refreshFooter();
      });
    }

    // 总热量
    let totalCal = 0;
    for (const slot of MEAL_SLOTS) {
      const repl = cur[slot];
      if (repl) totalCal += repl.adjustedCalories ?? repl.baseCalories ?? 0;
    }
    if (totalCal > 0) {
      container.createEl("span", { text: `🔥 ${totalCal} kcal`, attr: { style: "font-size:12px;font-weight:700;color:var(--nd-text);margin-left:auto;" } });
    }
  }

  /** 我的食谱右下角浮动删除按钮 */
  private _renderDeleteModeButton(container: HTMLElement): void {
    const fab = container.createEl("button", {
      text: this.deleteMode ? "✅ 完成" : "🗑️",
      attr: { style: `position:fixed;bottom:24px;right:24px;width:48px;height:48px;border-radius:50%;border:none;background:${this.deleteMode ? "var(--nd-accent)" : "#e74c3c"};color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.2);z-index:100;` }
    });
    fab.addEventListener("click", () => {
      this.deleteMode = !this.deleteMode;
      this.rerenderGrid();
      fab.setText(this.deleteMode ? "✅ 完成" : "🗑️");
      fab.style.background = this.deleteMode ? "var(--nd-accent)" : "#e74c3c";
    });
  }

  private catEmoji(id: string): string {
    const m: Record<string, string> = { meat_dish:"🥩", vegetable_dish:"🥬", staple:"🍚", breakfast:"🌅", soup:"🥣", aquatic:"🐟", drink:"🥤", condiment:"🧂", "semi-finished":"📦", dessert:"🍰" };
    return m[id] || "📋";
  }

  private slotEmoji(s: string): string {
    const m: Record<string, string> = { "早餐":"🌅", "午餐":"☀️", "晚餐":"🌙", "加餐":"🍪" };
    return m[s] || "🍳";
  }
}
