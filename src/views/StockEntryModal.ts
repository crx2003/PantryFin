// src/views/StockEntryModal.ts — PantryFin v1.3
//
// 独立 Modal: 不受 DashboardView root.empty() 影响。
// 支持入库(合并)、消耗(扣减)、取消。

import { App, Modal, Notice } from "obsidian";
import { normalize, formatBase } from "../utils/units";

export class StockEntryModal extends Modal {
  private category: string;
  private prefilledName: string;
  private context: any; // ICardContext

  constructor(
    app: App,
    context: any,
    category?: string,
    prefilledName?: string
  ) {
    super(app);
    this.context = context;
    this.category = category || "蛋白质";
    this.prefilledName = prefilledName || "";
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("stock-entry-modal");
    contentEl.setCssStyles({ padding: "24px", minWidth: "360px" });

    contentEl.createEl("h3", { text: "📦 库存操作", attr: { style: "margin:0 0 16px;" } });

    // 类别
    const catRow = contentEl.createDiv({ attr: { style: "margin-bottom:10px;" } });
    catRow.createEl("label", { text: "类别", attr: { style: "display:block;font-size:12px;color:var(--nd-text-soft);margin-bottom:4px;" } });
    const catSelect = catRow.createEl("select", { attr: { style: "width:100%;padding:8px;border-radius:6px;border:1px solid var(--nd-card-border);background:var(--nd-card-bg);color:var(--nd-text);" } });
    ["肉类", "蔬菜", "主食", "营养品", "配料", "蛋白质", "乳制品", "调料", "水果"].forEach(c => {
      const o = catSelect.createEl("option", { text: c, value: c });
      if (c === this.category) o.selected = true;
    });

    // 名称
    const nameRow = contentEl.createDiv({ attr: { style: "margin-bottom:10px;" } });
    nameRow.createEl("label", { text: "食材名称", attr: { style: "display:block;font-size:12px;color:var(--nd-text-soft);margin-bottom:4px;" } });
    const nameInput = nameRow.createEl("input", {
      type: "text", value: this.prefilledName,
      placeholder: "如: 牛奶、鸡胸肉",
      attr: { style: "width:100%;padding:8px;border-radius:6px;border:1px solid var(--nd-card-border);background:var(--nd-card-bg);color:var(--nd-text);" }
    }) as HTMLInputElement;

    // 数量
    const qtyRow = contentEl.createDiv({ attr: { style: "margin-bottom:16px;" } });
    qtyRow.createEl("label", { text: "数量", attr: { style: "display:block;font-size:12px;color:var(--nd-text-soft);margin-bottom:4px;" } });
    const qtyInput = qtyRow.createEl("input", {
      type: "text",
      placeholder: "如: 500g / 1L / 1l / 一升 / 10枚",
      attr: { style: "width:100%;padding:8px;border-radius:6px;border:1px solid var(--nd-card-border);background:var(--nd-card-bg);color:var(--nd-text);" }
    }) as HTMLInputElement;
    // 自动聚焦
    setTimeout(() => qtyInput.focus(), 50);

    // 按钮行
    const btnRow = contentEl.createDiv({ attr: { style: "display:flex;gap:8px;" } });

    const submitBtn = btnRow.createEl("button", {
      text: "➕ 合并入库",
      attr: { style: "flex:1;padding:10px;border:none;border-radius:6px;background:var(--nd-accent);color:#fff;cursor:pointer;font-weight:600;" }
    }) as HTMLButtonElement;

    const deductBtn = btnRow.createEl("button", {
      text: "➖ 消耗吃掉",
      attr: { style: "flex:1;padding:10px;border:1px solid var(--nd-card-border);border-radius:6px;background:var(--nd-card-bg);color:var(--nd-text);cursor:pointer;" }
    }) as HTMLButtonElement;

    const cancelBtn = contentEl.createEl("button", {
      text: "✖ 取消",
      attr: { style: "margin-top:8px;width:100%;padding:8px;border:1px solid var(--nd-card-border);border-radius:6px;background:transparent;color:var(--nd-text-soft);cursor:pointer;" }
    }) as HTMLButtonElement;

    const self = this;
    const pantryPath = this.context.settings.pantryPath;

    const doSubmit = async (isDeduct: boolean) => {
      const name = nameInput.value.trim();
      const qty = qtyInput.value.trim();
      if (!name || !qty) {
        new Notice("⚠️ 请填写食材名称与数量");
        return;
      }

      const norm = normalize(qty);
      if (!norm) {
        new Notice(`❌ 无法识别格式: "${qty}"。支持: 500g / 1L / 1l / 250ml / 10枚 / 一升`);
        return;
      }

      if (isDeduct) {
        const pantry = self.context.pantryParser || self.context.getPantryParser?.();
        // 诊断: 显示实际扣减的 base 值
        new Notice(`🔍 扣减: ${name} amount_g=${norm.value} baseUnit=${norm.baseUnit}`);
        const result = await pantry.deductStock(pantryPath, [{ name, amount_g: norm.value }]);
        new Notice(`➖ 已消耗: ${name} (-${formatBase(norm.value, norm.baseUnit)})`);
        if (result.warnings?.length) new Notice(`⚠️ ${result.warnings.join("; ")}`, 6000);
      } else {
        const pantry = self.context.pantryParser || self.context.getPantryParser?.();
        await pantry.manualAddOrMergeItem(pantryPath, catSelect.value, name, qty);
        new Notice(`✅ 已录入: ${name} (${formatBase(norm.value, norm.baseUnit)})`);
      }

      self.close();
      self.context.scheduleRender();
    };

    submitBtn.onclick = () => doSubmit(false);
    deductBtn.onclick = () => doSubmit(true);
    cancelBtn.onclick = () => self.close();

    qtyInput.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter") doSubmit(false);
      if (e.key === "Escape") self.close();
    };
    nameInput.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") self.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
