// src/views/HtmlReaderView.ts
//
// v4.3 HTML 离线阅读器 — 在 Obsidian 内部渲染离线食谱网页

import { ItemView, WorkspaceLeaf, TFile, Platform } from "obsidian";

export const VIEW_TYPE_HTML_READER = "pantryfin-html-reader";

export class HtmlReaderView extends ItemView {
  private htmlContent: string = "";
  private filePath: string = "";
  private sourceUrl: string = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_HTML_READER;
  }

  getDisplayText(): string {
    return "🌐 食谱阅读器";
  }

  getIcon(): string {
    return "globe";
  }

  /** 加载并渲染 HTML 文件 */
  async loadHtml(file: TFile): Promise<void> {
    this.filePath = file.path;
    try {
      this.htmlContent = await this.app.vault.read(file);
      // 从 HTML 中提取来源 URL
      const sourceMatch = this.htmlContent.match(/原始来源:\s*<a[^>]*href="([^"]+)"/);
      this.sourceUrl = sourceMatch ? sourceMatch[1]! : "";
    } catch {
      this.htmlContent = "<p>无法加载 HTML 文件</p>";
    }
    this.renderHtml();
  }

  /** 直接渲染 HTML 字符串 (用于已读取的内容) */
  setHtml(content: string, path: string): void {
    this.htmlContent = content;
    this.filePath = path;
    this.renderHtml();
  }

  private renderHtml(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    container.style.cssText = "padding:0;overflow:hidden;height:100%;";

    // ── 工具栏 ──
    const toolbar = container.createDiv({
      attr: { style: "display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--nd-panel-bg);border-bottom:1px solid var(--nd-card-border);flex-shrink:0;" }
    });
    toolbar.createSpan({ text: "🌐 离线食谱", attr: { style: "font-weight:700;font-size:13px;color:var(--nd-accent);" } });
    toolbar.createSpan({ text: this.filePath, attr: { style: "font-size:11px;color:var(--nd-text-soft);flex:1;" } });

    // 外部浏览器打开按钮
    const extBtn = toolbar.createEl("button", {
      text: "↗ 浏览器打开",
      attr: { style: "padding:3px 8px;border:1px solid var(--nd-card-border);border-radius:4px;background:var(--nd-card-bg);color:var(--nd-text);cursor:pointer;font-size:11px;" }
    });
    extBtn.addEventListener("click", () => {
      if (typeof (this.app as any).openWithDefaultApp === "function") {
        (this.app as any).openWithDefaultApp(this.filePath);
      }
    });

    // P2 移动端: 注入自适应样式，防止离线 HTML 横向溢出
    const content = Platform.isMobile
      ? this._applyMobileFormatting(this.htmlContent)
      : this.htmlContent;

    // ── iframe 渲染区 ──
    const iframe = container.createEl("iframe", {
      attr: {
        sandbox: "allow-scripts allow-same-origin",
        style: "width:100%;height:100%;border:none;flex:1;",
      }
    });
    iframe.srcdoc = content;
  }

  /** P2 移动端: 注入自适应样式，防止离线 HTML 排版断裂 */
  private _applyMobileFormatting(htmlContent: string): string {
    const mobileCss = `
      <style>
        body,html{max-width:100vw!important;overflow-x:hidden!important}
        img{max-width:100%!important;height:auto!important;object-fit:contain}
        body{font-size:16px!important;line-height:1.75!important;padding:12px!important}
      </style>`;
    return htmlContent.replace(/<\/head>/i, `${mobileCss}</head>`);
  }

  async onOpen(): Promise<void> {
    // 等待外部调用 loadHtml / setHtml
  }

  async onClose(): Promise<void> {
    // noop
  }
}
