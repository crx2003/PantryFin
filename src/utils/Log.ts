// src/utils/Log.ts
//
// Templater 风格结构化日志: Notice + Console 双通道。

import { Notice } from "obsidian";

/** 普通信息（仅控制台） */
export function log_info(msg: string): void {
    console.log(`[PantryFin] ${msg}`);
}

/** 警告（控制台 + 可选 Notice） */
export function log_warn(msg: string, showNotice = false): void {
    console.warn(`[PantryFin] ${msg}`);
    if (showNotice) {
        new Notice(`⚠️ ${msg}`, 5000);
    }
}

/** 错误（Notice 用户可见 + 控制台详情） */
export function log_error(msg: string, consoleDetail?: string): void {
    const notice = new Notice("", 8000);
    const frag = new DocumentFragment();
    const title = frag.createEl("b", { text: "PantryFin" });
    frag.createEl("br");
    frag.createSpan({ text: msg });
    notice.noticeEl.appendChild(frag);

    console.error(`[PantryFin] ${msg}`, consoleDetail || "");
}
