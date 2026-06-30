// src/services/HtmlArchiver.ts
//
// v4.3 Track B: 双轨食谱存档 — 真正离线网页引擎
// 核心能力: 图片下载到本地 / 懒加载 src 改写 / 相对路径→绝对URL / script剔除

import { TFile, normalizePath, requestUrl } from "obsidian";
import type { App } from "obsidian";

export class HtmlArchiver {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * 将食谱网页 HTML 离线存档到 Vault（含图片本地化）。
   * @returns 存档文件的 vault 相对路径，失败返回 null
   */
  async archive(
    rawHtml: string,
    sourceUrl: string,
    recipeName: string,
    onProgress?: (msg: string) => void
  ): Promise<string | null> {
    try {
      const cleanName = recipeName.replace(/[\\/:*?"<>|]/g, "_");
      const assetFolder = `Diet/Recipe_Assets/${cleanName}`;

      await this._ensureFolder(assetFolder);

      const doc = new DOMParser().parseFromString(rawHtml, "text/html");
      const origin = this._getOrigin(sourceUrl);

      // 1. 懒加载图片 src 解析 (先还原真实 URL)
      const imgEls = Array.from(doc.querySelectorAll("img"));
      onProgress?.(`📦 检测到 ${imgEls.length} 张图片，开始下载...`);

      // 2. 下载每张图片到本地 + 改写 src
      const imagesDir = `${assetFolder}/images`;
      await this._ensureFolder(imagesDir);

      let downloaded = 0;
      for (let i = 0; i < imgEls.length; i++) {
        const img = imgEls[i]!;
        const realSrc =
          img.getAttribute("data-src") ||
          img.getAttribute("data-original") ||
          img.getAttribute("data-actualsrc") ||
          img.getAttribute("src") ||
          "";

        if (!realSrc || realSrc.startsWith("data:")) continue;

        const absoluteUrl = this._toAbsoluteUrl(realSrc, origin);
        const ext = this._guessImageExt(absoluteUrl);

        try {
          const resp = await requestUrl({ url: absoluteUrl, method: "GET" });
          if (resp.status === 200) {
            const localName = `img_${String(i + 1).padStart(2, "0")}.${ext}`;
            const localPath = normalizePath(`${imagesDir}/${localName}`);

            // 写入 vault (二进制)
            const existing = this.app.vault.getAbstractFileByPath(localPath);
            if (existing instanceof TFile) {
              await this.app.vault.modifyBinary(existing, resp.arrayBuffer);
            } else {
              await this.app.vault.createBinary(localPath, resp.arrayBuffer);
            }

            // 改写 src → 本地相对路径
            img.setAttribute("src", `images/${localName}`);
            downloaded++;
            onProgress?.(`📥 [${i + 1}/${imgEls.length}] ${localName}`);
          }
        } catch {
          // 下载失败: 保留外链 URL (断网不可用但至少不丢引用)
          img.setAttribute("src", absoluteUrl);
        }

        // 清理懒加载属性
        img.removeAttribute("data-src");
        img.removeAttribute("data-original");
        img.removeAttribute("data-actualsrc");
        img.removeAttribute("srcset");
        img.removeAttribute("loading");
      }

      // 3. CSS 相对路径 → 绝对 URL (样式保留外链，断网时排版降级但文字可读)
      doc.querySelectorAll('link[rel="stylesheet"], link[href]').forEach(link => {
        const href = link.getAttribute("href");
        if (href) link.setAttribute("href", this._toAbsoluteUrl(href, origin));
      });

      // 4. 背景图相对路径
      doc.querySelectorAll('[style*="background"], [style*="url("]').forEach(el => {
        const style = el.getAttribute("style") || "";
        const fixed = style.replace(/url\(['"]?(\/[^'")\s]+)['"]?\)/g, (_m, path) => {
          return `url("${this._toAbsoluteUrl(path, origin)}")`;
        });
        if (fixed !== style) el.setAttribute("style", fixed);
      });

      // 5. 链接相对路径补全
      doc.querySelectorAll("a[href]").forEach(a => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("/") || (!href.startsWith("http") && !href.startsWith("#") && !href.startsWith("mailto:") && !href.startsWith("javascript:"))) {
          a.setAttribute("href", this._toAbsoluteUrl(href, origin));
        }
      });

      // 6. 移除危险/冗余标签
      doc.querySelectorAll("script, iframe, object, embed").forEach(el => el.remove());
      doc.querySelectorAll(
        ".ad, .advertisement, .recommend, .related-posts, .comment, .comments, " +
        ".footer, .share-buttons, .social-share, [class*='banner'], [id*='ad']"
      ).forEach(el => el.remove());

      // 7. 离线标识
      const banner = doc.createElement("div");
      const bannerDiv = doc.createElement("div");
      bannerDiv.setAttribute("style", "position:fixed;top:0;left:0;right:0;z-index:9999;background:rgba(153,135,108,0.95);color:#fff;padding:6px 16px;font-size:12px;text-align:center;font-family:sans-serif;box-shadow:0 1px 4px rgba(0,0,0,0.15);");
      bannerDiv.textContent = `📦 PantryFin 离线食谱存档 (${downloaded}/${imgEls.length} 图片已本地化) · 原始来源: `;
      const aEl = doc.createElement("a");
      aEl.setAttribute("href", sourceUrl);
      aEl.setAttribute("style", "color:#fff;text-decoration:underline;");
      aEl.textContent = sourceUrl;
      bannerDiv.appendChild(aEl);
      const spacer = doc.createElement("div");
      spacer.setAttribute("style", "height:36px;");
      banner.appendChild(bannerDiv);
      banner.appendChild(spacer);
      doc.body?.insertBefore(banner, doc.body.firstChild);

      // 8. 序列化
      const doctype = "<!DOCTYPE html>\n";
      const htmlAttrs = doc.documentElement.getAttribute("lang")
        ? ` lang="${doc.documentElement.getAttribute("lang")}"`
        : ' lang="zh-CN"';
      const headHTML = doc.head?.innerHTML || "";
      const bodyHTML = doc.body?.innerHTML || "";
      const metaCharset = doc.querySelector("meta[charset]") ? "" : '<meta charset="UTF-8">\n';
      const metaViewport = doc.querySelector("meta[name='viewport']")
        ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n';

      const output = `${doctype}<html${htmlAttrs}>
<head>
${metaCharset}${metaViewport}${headHTML}
</head>
<body>
${bodyHTML}
</body>
</html>`;

      // 9. 落盘 index.html
      const indexPath = normalizePath(`${assetFolder}/index.html`);
      const existing = this.app.vault.getAbstractFileByPath(indexPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, output);
      } else {
        await this.app.vault.create(indexPath, output);
      }

      onProgress?.(`✅ 存档完成: ${downloaded} 张图片已本地化`);
      return indexPath;
    } catch (e) {
      console.warn("[HtmlArchiver] 存档失败:", e);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  工具方法
  // ══════════════════════════════════════════════════════

  private _getOrigin(url: string): string {
    try { const u = new URL(url); return `${u.protocol}//${u.host}`; }
    catch { return url; }
  }

  private _toAbsoluteUrl(path: string, origin: string): string {
    if (!path) return path;
    if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("data:")) return path;
    try { return new URL(path, origin).href; }
    catch { return path; }
  }

  /** 从 URL 猜测图片扩展名 */
  private _guessImageExt(url: string): string {
    const m = url.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?|#|$)/i);
    return m ? m[1]!.toLowerCase() : "jpg";
  }

  private async _ensureFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
