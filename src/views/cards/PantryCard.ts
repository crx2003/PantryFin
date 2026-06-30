import { Notice } from "obsidian";
import { BaseCard } from "./BaseCard";
import { StockEntryModal } from "../StockEntryModal";

export class PantryCard extends BaseCard {
  async render(): Promise<void> {
    const self = this;
    const card = this.createCard("pantry", "📦 食材库存", "");
    const header = card.querySelector(".museum-live-card-header") as HTMLElement;

    const addStockBtn = header.createEl("button", {
      cls: "nutri-add-stock-btn", text: "➕ 录入",
      attr: { type: "button" }
    }) as HTMLButtonElement;
    addStockBtn.onclick = () => {
      new StockEntryModal(self.context.app, self.context).open();
    };

    const pantryParser = this.context.getPantryParser();
    const pantry = await pantryParser.readPantry(this.context.settings.pantryPath);

    if (!pantry || pantry.length === 0) {
      card.createEl("p", { text: "当前空仓，请点击右上角➕录入库存", cls: "nutri-muted" });
    } else {
      const gridBox = card.createDiv({ cls: "nutri-pantry-grid" });
      const catOrder = ["肉类", "蛋白质", "蔬菜", "主食", "碳水", "营养品", "水果", "乳制品", "配料", "调料", "食材"];
      const catRank = (c: string) => { const i = catOrder.findIndex(x => c.includes(x) || x.includes(c)); return i >= 0 ? i : 99; };
      const sorted = [...pantry].sort((a: any, b: any) => {
        const ra = catRank(a.category || ""), rb = catRank(b.category || "");
        if (ra !== rb) return ra - rb;
        const aZero = parseFloat(a.quantity) <= 0, bZero = parseFloat(b.quantity) <= 0;
        if (aZero && !bZero) return 1;
        if (!aZero && bZero) return -1;
        return 0;
      });
      for (const item of sorted) {
        const pill = gridBox.createDiv({ cls: "nutri-pantry-pill" });
        const isZero = parseFloat(item.quantity) <= 0;
        if (isZero) pill.addClass("pill-zero");
        const cat = item.category || "";
        if (!isZero) {
          if (cat === "肉类" || cat === "蛋白质") pill.addClass("pill-meat");
          else if (cat === "蔬菜") pill.addClass("pill-veg");
          else if (cat === "主食" || cat === "碳水") pill.addClass("pill-staple");
          else if (cat === "营养品" || cat === "水果" || cat === "乳制品") pill.addClass("pill-nutri");
          else pill.addClass("pill-other");
        }
        pill.title = `${item.name}: ${item.quantity} · ${cat}`;
        pill.createEl("strong", { cls: "pill-name", text: item.name });
        pill.createEl("span", { cls: "pill-qty", text: item.quantity });
        pill.onclick = () => {
          new StockEntryModal(self.context.app, self.context, item.category, item.name).open();
        };
      }
    }
  }
}
